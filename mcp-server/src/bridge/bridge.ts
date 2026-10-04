/**
 * ExtensionBridge: owns the single link to the Firefox WebExtension and
 * multiplexes command/response round-trips over it.
 *
 * Transport-agnostic: the native host feeds parsed messages in via receive()
 * and gives us a BridgeLink to send on. Native messaging is already trusted
 * (Firefox only lets allowed_extensions launch the host), so there is no token
 * handshake on this side — the token guards the harness-facing HTTP endpoint.
 *
 * - MCP tool handlers from MANY harness sessions share this bridge; commands are
 *   sent immediately and matched by id, so a long act_wait never blocks other calls.
 * - Tab events (tab.updated/removed/activated, download.done) are pushed by the
 *   extension and fanned out to waiters (wait_for_tab_event).
 */

import { randomUUID, timingSafeEqual, createHash } from "node:crypto";
import {
  isEvent,
  isResponse,
  type BridgeCommand,
  type BridgeEvent,
  type BridgeEventType,
  type BridgeMethod,
  type HelloMessage,
  MAX_HOST_MESSAGE_BYTES,
} from "@webmcp-controller/shared";
import { currentSignal, currentThought } from "./thought.js";

export interface ExtensionInfo {
  extensionId: string;
  version: string;
  profile: string;
  firefoxVersion: string;
  capabilities: string[];
  connectedAt: number;
}

export interface BridgeEventRecord extends BridgeEvent {
  /** Increases by one per event; pass as `afterSeq` to wait for anything newer. */
  seq: number;
  receivedAt: number;
}

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  method: BridgeMethod;
};

export class BridgeError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Anything that can carry one JSON message to the extension. */
export interface BridgeLink {
  send(msg: unknown): void;
}

export class ExtensionBridge {
  private socket: BridgeLink | null = null;
  private cmdTimeoutMs: number;
  private info: ExtensionInfo | null = null;
  /** Set when the connected add-on can't be driven (e.g. protocol mismatch). */
  private refusal: { code: string; message: string } | null = null;
  private eventSeq = 0;

  /** command id -> pending resolver */
  private pending = new Map<string, Pending>();

  /** ring buffer of recent events (for waiters that attach late) */
  private recentEvents: BridgeEventRecord[] = [];
  private eventWaiters: Array<{
    types: Set<BridgeEventType>;
    predicate: (e: BridgeEvent) => boolean;
    resolve: (e: BridgeEventRecord) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  onStatusChange: ((connected: boolean, info: ExtensionInfo | null) => void) | null = null;

  constructor(opts: { cmdTimeoutMs?: number } = {}) {
    this.cmdTimeoutMs = opts.cmdTimeoutMs ?? 30_000;
  }

  get connected(): boolean {
    return this.socket !== null;
  }

  get extensionInfo(): ExtensionInfo | null {
    return this.info;
  }

  // ---------------------------------------------------------- connection ---

  /**
   * The extension said hello on `link`; make it the live link. With `refuse`,
   * the link is kept (for status) but every command fails with that error.
   */
  connect(link: BridgeLink, hello: HelloMessage["hello"], refuse?: { code: string; message: string }): void {
    if (this.socket && this.socket !== link) {
      this.failPending("NOT_CONNECTED", "extension replaced by a new connection");
    }
    this.socket = link;
    this.refusal = refuse ?? null;
    this.info = {
      extensionId: hello.extensionId,
      version: hello.version,
      profile: hello.profile,
      firefoxVersion: hello.firefoxVersion,
      capabilities: hello.capabilities,
      connectedAt: Date.now(),
    };
    this.dispatchEvent({ event: "extension.ready", data: { ...(this.info as unknown as Record<string, unknown>) } });
    this.onStatusChange?.(true, this.info);
  }

  /** The link went away (stdin closed, extension reloaded). */
  disconnect(): void {
    if (!this.socket) return;
    this.socket = null;
    this.info = null;
    this.refusal = null;
    this.failPending("NOT_CONNECTED", "extension disconnected");
    for (const w of this.eventWaiters) {
      clearTimeout(w.timer);
      w.reject(new BridgeError("NOT_CONNECTED", "extension disconnected while waiting for an event"));
    }
    this.eventWaiters = [];
    this.onStatusChange?.(false, null);
  }

  /** Feed one parsed message from the extension (response or event). */
  receive(msg: unknown): void {
    if (isResponse(msg)) {
      const p = this.pending.get(msg.id);
      if (!p) return; // late/duplicate response
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new BridgeError(msg.error?.code ?? "EXTENSION_ERROR", msg.error?.message ?? "unknown extension error"));
      return;
    }
    if (isEvent(msg)) this.dispatchEvent(msg);
  }

  private failPending(code: string, msg: string): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new BridgeError(code, msg));
    }
    this.pending.clear();
  }

  // ------------------------------------------------------------- command ---

  /**
   * Send a command to the extension and await its response (matched by id).
   * Aborting `signal` (default: the current MCP request's) rejects with
   * CANCELLED and tells the extension to stop.
   */
  call(
    method: BridgeMethod,
    params: Record<string, unknown> = {},
    opts?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<unknown> {
    const timeoutMs = opts?.timeoutMs ?? this.cmdTimeoutMs;
    const signal = opts?.signal ?? currentSignal();
    const thought = currentThought();
    if (thought && params["thought"] === undefined) params = { ...params, thought };
    return new Promise((resolve, reject) => {
      const link = this.socket;
      if (!link) {
        reject(
          new BridgeError(
            "NOT_CONNECTED",
            "extension not connected — check the WebMCP Controller toolbar icon in Firefox",
          ),
        );
        return;
      }
      if (this.refusal) {
        reject(new BridgeError(this.refusal.code, this.refusal.message));
        return;
      }
      if (signal?.aborted) {
        reject(new BridgeError("CANCELLED", `${method} was cancelled`));
        return;
      }
      const id = randomUUID();
      const cmd: BridgeCommand = { id, method, params };
      const size = Buffer.byteLength(JSON.stringify(cmd), "utf8");
      if (size > MAX_HOST_MESSAGE_BYTES) {
        reject(
          new BridgeError(
            "PAYLOAD_TOO_LARGE",
            `${method} arguments are ${Math.ceil(size / 1024)} KB; Firefox accepts at most ${MAX_HOST_MESSAGE_BYTES / 1024} KB per message. Send less at once.`,
          ),
        );
        return;
      }
      const onAbort = (): void => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        try {
          link.send({ cancel: id });
        } catch {
          /* link gone; nothing to cancel */
        }
        reject(new BridgeError("CANCELLED", `${method} was cancelled`));
      };
      const done = (): void => signal?.removeEventListener("abort", onAbort);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        done();
        try {
          link.send({ cancel: id }); // don't leave it running (e.g. an act.wait) in Firefox
        } catch {
          /* link gone */
        }
        reject(new BridgeError("TIMEOUT", `extension command ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        resolve: (v) => {
          done();
          resolve(v);
        },
        reject: (e) => {
          done();
          reject(e);
        },
        timer,
        method,
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        link.send(cmd);
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        done();
        reject(new BridgeError("NOT_CONNECTED", `failed to send to extension: ${String(e)}`));
      }
    });
  }

  // --------------------------------------------------------------- event ---

  private dispatchEvent(evt: BridgeEvent): void {
    const record: BridgeEventRecord = { ...evt, seq: ++this.eventSeq, receivedAt: Date.now() };
    this.recentEvents.push(record);
    if (this.recentEvents.length > 200) this.recentEvents.splice(0, this.recentEvents.length - 200);
    const stillWaiting: typeof this.eventWaiters = [];
    for (const w of this.eventWaiters) {
      if (w.types.has(evt.event)) {
        try {
          if (w.predicate(evt)) {
            clearTimeout(w.timer);
            w.resolve(record);
            continue;
          }
        } catch {
          /* predicate threw — keep waiting */
        }
      }
      stillWaiting.push(w);
    }
    this.eventWaiters = stillWaiting;
  }

  /** seq of the newest event so far (0 if none). */
  get lastEventSeq(): number {
    return this.eventSeq;
  }

  /**
   * Wait for an extension-pushed event matching types+predicate that arrives
   * after this call, or (with `afterSeq`) any buffered event newer than that seq.
   */
  waitForEvent(
    types: BridgeEventType[],
    predicate: (e: BridgeEvent) => boolean,
    timeoutMs: number,
    opts: { afterSeq?: number; signal?: AbortSignal } = {},
  ): Promise<BridgeEventRecord> {
    const typeSet = new Set(types);
    const signal = opts.signal ?? currentSignal();
    if (opts.afterSeq !== undefined) {
      for (const r of this.recentEvents) {
        if (r.seq <= opts.afterSeq || !typeSet.has(r.event)) continue;
        try {
          if (predicate(r)) return Promise.resolve(r);
        } catch {
          /* ignore */
        }
      }
    }
    if (!this.socket) {
      return Promise.reject(new BridgeError("NOT_CONNECTED", "extension not connected"));
    }
    if (signal?.aborted) return Promise.reject(new BridgeError("CANCELLED", "wait was cancelled"));
    return new Promise((resolve, reject) => {
      const drop = (): void => {
        this.eventWaiters = this.eventWaiters.filter((w) => w.timer !== timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = (): void => {
        clearTimeout(timer);
        drop();
        reject(new BridgeError("CANCELLED", "wait was cancelled"));
      };
      const timer = setTimeout(() => {
        drop();
        reject(new BridgeError("TIMEOUT", `timed out waiting for ${types.join("|")} after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      signal?.addEventListener("abort", onAbort, { once: true });
      this.eventWaiters.push({
        types: typeSet,
        predicate,
        resolve: (e) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(e);
        },
        reject: (e) => {
          signal?.removeEventListener("abort", onAbort);
          reject(e);
        },
        timer,
      });
    });
  }
}

/** Constant-time token comparison (hash first so lengths always match). */
export function tokensEqual(a: unknown, b: string): boolean {
  if (typeof a !== "string" || a.length === 0 || b.length === 0) return false;
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}
