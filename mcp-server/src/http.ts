/**
 * Harness-facing MCP endpoint: stateless Streamable HTTP on /mcp with bearer
 * auth. Restartable, because the extension can change port/bind/token at any time.
 */

import express, { type NextFunction, type Request, type Response } from "express";
import { createServer, type Server } from "node:http";
import os from "node:os";
import { VERSION } from "@webmcp-controller/shared";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { ServerConfig } from "./config.js";
import { tokensEqual, type ExtensionBridge } from "./bridge/bridge.js";
import { withSignal } from "./bridge/thought.js";
import { registerFirefoxTools, SERVER_INSTRUCTIONS } from "./tools/index.js";

export const SERVER_VERSION = VERSION;

export interface HttpState {
  listening: boolean;
  url: string;
  extraUrls: string[];
  wslAddress: string;
  port: number;
  bind: string;
  error: string;
  requests: number;
}

/** IPv4 addresses of the Windows "vEthernet (WSL...)" adapter(s); what WSL's default gateway points at. */
export function wslAddresses(): string[] {
  if (process.platform !== "win32") return [];
  const out: string[] = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (!/wsl/i.test(name)) continue;
    for (const a of addrs ?? []) if (a.family === "IPv4" && !a.internal) out.push(a.address);
  }
  return out;
}

const urlFor = (host: string, port: number): string =>
  `http://${host.includes(":") ? `[${host}]` : host}:${port}/mcp`;

const LOOPBACK_NAMES = new Set(["127.0.0.1", "localhost", "::1"]);
const isLoopbackBind = (bind: string): boolean => LOOPBACK_NAMES.has(bind) || bind.startsWith("127.");

/** Hostname part of a Host header value ("[::1]:8901" -> "::1"). */
function hostName(value: string): string {
  const v = value.trim().toLowerCase();
  if (v.startsWith("[")) return v.slice(1, v.indexOf("]") > 0 ? v.indexOf("]") : undefined);
  const i = v.lastIndexOf(":");
  return i > 0 && v.indexOf(":") === i ? v.slice(0, i) : v;
}

const isWildcard = (bind: string): boolean => bind === "0.0.0.0" || bind === "::";

function closeServer(srv: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    srv.close(() => resolve());
    srv.closeAllConnections?.();
  });
}

const isIpLiteral = (h: string): boolean => /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(":");

type RpcId = string | number;
const rpcIds = (body: unknown): RpcId[] =>
  (Array.isArray(body) ? body : [body]).flatMap((m) => {
    const id = (m as { id?: unknown } | null)?.id;
    return typeof id === "string" || typeof id === "number" ? [id] : [];
  });

/** How often to re-check WSL adapters and retry a busy port. */
const RECONCILE_MS = 5000;
/** Right after a (re)start the old helper is usually still letting go of the port: retry quickly first. */
const QUICK_RETRY_MS = 250;
const QUICK_RETRIES = 12;
/**
 * Idle keep-alive sockets stay open longer than any client keeps them (Node's fetch: 4 s). With
 * Node's default of 5 s the server could close a socket just as a client reused it, failing that
 * request with ECONNRESET, which some clients count against the server.
 */
const KEEP_ALIVE_MS = 65_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class McpHttp {
  /** The main listener, and WSL extras by address. */
  private main: Server | null = null;
  private extras = new Map<string, Server>();
  private app: express.Express | null = null;
  private config: ServerConfig | null = null;
  /** Settings the open sockets were started with (config may be newer). */
  private active: ServerConfig | null = null;
  /** Settings we want listening; kept while a busy port is being retried. */
  private wanted: ServerConfig | null = null;
  private applying: Promise<void> = Promise.resolve();
  private applySeq = 0;
  private timer: NodeJS.Timeout | null = null;
  /** In-flight requests by JSON-RPC id, for notifications/cancelled. */
  private inflight = new Map<RpcId, Set<AbortController>>();
  private state: HttpState = {
    listening: false,
    url: "",
    extraUrls: [],
    wslAddress: "",
    port: 0,
    bind: "",
    error: "",
    requests: 0,
  };

  onChange: ((s: HttpState) => void) | null = null;

  constructor(
    private bridge: ExtensionBridge,
    /** Injectable for tests. */
    private findWsl: () => string[] = wslAddresses,
  ) {}

  get status(): HttpState {
    return { ...this.state, extraUrls: [...this.state.extraUrls] };
  }

  /**
   * (Re)start with new settings. No-op if nothing that affects the socket
   * changed. Calls run one at a time; if several queue up, only the newest
   * restarts the sockets.
   */
  apply(config: ServerConfig): Promise<void> {
    this.config = config; // token/confirm changes take effect on the next request
    const seq = ++this.applySeq;
    const run = async (): Promise<void> => {
      if (seq !== this.applySeq) return; // superseded
      const prev = this.active;
      if (
        prev &&
        this.main &&
        prev.port === config.port &&
        prev.bind === config.bind &&
        prev.allowWsl === config.allowWsl
      ) {
        this.emit();
        return;
      }
      await this.stop();
      this.wanted = config;
      this.startTimer();
      await this.listen(config);
      for (let i = 0; i < QUICK_RETRIES && !this.main && this.state.error.startsWith("Port "); i++) {
        await sleep(QUICK_RETRY_MS);
        if (seq !== this.applySeq || this.wanted !== config) return;
        await this.listen(config);
      }
    };
    return this.queue(run);
  }

  private queue(run: () => Promise<void>): Promise<void> {
    this.applying = this.applying.then(run, run);
    return this.applying;
  }

  async stop(): Promise<void> {
    const servers = [...(this.main ? [this.main] : []), ...this.extras.values()];
    this.main = null;
    this.extras.clear();
    this.active = null;
    this.wanted = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.state.listening = false;
    await Promise.all(servers.map(closeServer));
  }

  private emit(): void {
    this.onChange?.(this.status);
  }

  private startTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.queue(() => this.reconcile()), RECONCILE_MS);
    this.timer.unref();
  }

  /**
   * Runs every few seconds: retry a port that was busy (an old helper still
   * shutting down, another app that has since quit), and follow the WSL
   * adapter, which can appear after Firefox starts or change address after
   * sleep or a WSL restart. Exposed for tests.
   */
  async reconcile(): Promise<void> {
    const want = this.wanted;
    if (!want) return;
    if (!this.main) {
      if (this.state.error.startsWith("Port ")) await this.listen(want);
      return;
    }
    await this.syncWsl(want);
  }

  private async listen(config: ServerConfig): Promise<void> {
    const app = (this.app ??= this.buildApp());
    const wildcard = isWildcard(config.bind);
    // 127.0.0.1, not "localhost": some clients resolve localhost to ::1 first.
    const host = wildcard ? "127.0.0.1" : config.bind;
    this.state = {
      ...this.state,
      listening: false,
      port: config.port,
      bind: config.bind,
      url: urlFor(host, config.port),
      extraUrls: [],
      error: "",
    };

    const { srv, err } = await this.listenOne(app, config.port, config.bind);
    if (!srv) {
      if (err !== this.lastLogged) console.error(`[webmcp] ${err}`);
      this.lastLogged = err;
      this.state.error = err;
      this.emit();
      return;
    }
    this.lastLogged = "";
    this.main = srv;
    this.active = config;
    this.state.listening = true;
    await this.syncWsl(config, true);
  }
  private lastLogged = "";

  /** Make the WSL listeners match the adapter addresses that exist right now. */
  private async syncWsl(config: ServerConfig, force = false): Promise<void> {
    const all = this.findWsl();
    const wsl = config.allowWsl ? all : [];
    const before = JSON.stringify([this.state.extraUrls, this.state.wslAddress]);
    this.state.wslAddress = all[0] ?? "";
    if (isWildcard(config.bind)) {
      // Already reachable on every address.
      this.state.extraUrls = wsl.map((a) => urlFor(a, config.port));
    } else {
      const want = new Set(wsl.filter((a) => a !== config.bind));
      for (const [addr, srv] of this.extras) {
        if (want.has(addr)) continue;
        this.extras.delete(addr);
        console.error(`[webmcp] WSL address ${addr} is gone; stopped listening there`);
        void closeServer(srv);
      }
      for (const addr of want) {
        if (this.extras.has(addr)) continue;
        const { srv, err } = await this.listenOne(this.app!, config.port, addr);
        if (srv && this.main && this.active === config) this.extras.set(addr, srv);
        else if (srv) void closeServer(srv);
        else if (err !== this.lastLogged) {
          console.error(`[webmcp] WSL listener: ${err}`);
          this.lastLogged = err;
        }
      }
      this.state.extraUrls = [...this.extras.keys()].map((a) => urlFor(a, config.port));
    }
    if (force || JSON.stringify([this.state.extraUrls, this.state.wslAddress]) !== before) this.emit();
  }

  /** Listen on one address; resolves to the server, or a human-readable error. */
  private listenOne(app: express.Express, port: number, bind: string): Promise<{ srv?: Server; err: string }> {
    const srv = createServer(app);
    srv.keepAliveTimeout = KEEP_ALIVE_MS;
    srv.headersTimeout = KEEP_ALIVE_MS + 1000;
    // Tool calls can legitimately take minutes (waits, slow pages); never cut one off.
    srv.requestTimeout = 0;
    return new Promise((resolve) => {
      srv.once("error", (err: NodeJS.ErrnoException) => {
        resolve({
          err:
            err.code === "EADDRINUSE"
              ? `Port ${port} is already in use (another Firefox profile, or another app). Retrying every few seconds; pick a different port in settings if it stays busy.`
              : err.code === "EADDRNOTAVAIL"
                ? `Address ${bind} doesn't exist on this machine.`
                : err.code === "EACCES"
                  ? `Not allowed to listen on ${bind}:${port}.`
                  : `Listen failed: ${err.message}`,
        });
      });
      srv.listen(port, bind, () => {
        console.error(`[webmcp] MCP listening on ${bind}:${port}`);
        resolve({ srv, err: "" });
      });
    });
  }

  /** Is `host` (from a Host header) a name this server can legitimately be reached by? */
  private hostAllowed(host: string): boolean {
    const bind = this.active?.bind ?? this.config?.bind ?? "127.0.0.1";
    if (LOOPBACK_NAMES.has(host)) return true;
    if (this.config?.allowWsl && this.findWsl().includes(host)) return true;
    if (isLoopbackBind(bind)) return false; // DNS rebinding: evil.example -> 127.0.0.1
    const me = os.hostname().toLowerCase();
    return isIpLiteral(host) || host === me || host === `${me}.local`;
  }

  /** Browsers send Origin on cross-site requests; only loopback/WSL pages may call us. */
  private originAllowed(origin: string): boolean {
    let h: string;
    try {
      h = new URL(origin).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    } catch {
      return false;
    }
    if (LOOPBACK_NAMES.has(h)) return true;
    const bind = this.active?.bind ?? "";
    return (!isLoopbackBind(bind) && h === bind) || this.findWsl().includes(h);
  }

  private buildApp(): express.Express {
    const app = express();
    app.disable("x-powered-by");
    const rpcError = (res: Response, status: number, code: number, message: string): void => {
      res.status(status).json({ jsonrpc: "2.0", id: null, error: { code, message } });
    };

    const guard = (req: Request, res: Response, next: NextFunction): void => {
      const host = hostName(req.headers.host ?? "");
      if (!host || !this.hostAllowed(host)) {
        rpcError(res, 403, -32001, "forbidden: unexpected Host header");
        return;
      }
      const origin = req.headers.origin;
      if (origin !== undefined && !this.originAllowed(origin)) {
        rpcError(res, 403, -32001, "forbidden: cross-origin requests are not allowed");
        return;
      }
      next();
    };

    const auth = (req: Request, res: Response, next: NextFunction): void => {
      const header = req.headers.authorization ?? "";
      const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
      if (!this.config || !tokensEqual(presented, this.config.token)) {
        rpcError(res, 401, -32001, "unauthorized: missing or invalid bearer token");
        return;
      }
      next();
    };

    // Parse bodies only after auth, so unauthenticated clients can't make us buffer megabytes.
    const json = express.json({ limit: "2mb" });

    app.get("/health", guard, (_req: Request, res: Response) => {
      res.json({ ok: true, extensionConnected: this.bridge.connected, version: SERVER_VERSION });
    });

    app.get("/", guard, (_req: Request, res: Response) => {
      res
        .type("text")
        .send(
          `webmcp-controller ${SERVER_VERSION}\nextension: ${this.bridge.connected ? "connected" : "disconnected"}\n` +
            `MCP endpoint: POST /mcp (Streamable HTTP, Authorization: Bearer <token from the add-on popup>)\n`,
        );
    });

    const handle = async (req: Request, res: Response, body?: unknown): Promise<void> => {
      this.state.requests += 1;
      // notifications/cancelled: abort the matching in-flight request, if unambiguous.
      for (const m of Array.isArray(body) ? body : [body]) {
        const msg = m as { method?: unknown; params?: { requestId?: unknown } } | null;
        if (msg?.method !== "notifications/cancelled") continue;
        const rid = msg.params?.requestId;
        const set = typeof rid === "string" || typeof rid === "number" ? this.inflight.get(rid) : undefined;
        if (set?.size === 1) for (const c of set) c.abort();
      }
      const ctl = new AbortController();
      const ids = rpcIds(body);
      for (const id of ids) {
        let set = this.inflight.get(id);
        if (!set) this.inflight.set(id, (set = new Set()));
        set.add(ctl);
      }
      const unregister = (): void => {
        for (const id of ids) {
          const set = this.inflight.get(id);
          set?.delete(ctl);
          if (set && !set.size) this.inflight.delete(id);
        }
      };
      try {
        // Stateless: one McpServer + transport per request.
        const server = new McpServer(
          { name: "webmcp-controller", version: SERVER_VERSION },
          { instructions: SERVER_INSTRUCTIONS },
        );
        registerFirefoxTools(server, this.bridge, this.config!);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on("close", () => {
          if (!res.writableFinished) ctl.abort(); // client went away mid-call
          unregister();
          void transport.close().catch(() => {});
        });
        await server.connect(transport);
        await withSignal(ctl.signal, () => transport.handleRequest(req, res, body));
      } catch (err) {
        console.error(`[webmcp] MCP request failed: ${String(err)}`);
        if (!res.headersSent) rpcError(res, 500, -32603, "internal error");
      }
    };

    app.post("/mcp", guard, auth, json, (req: Request, res: Response) => void handle(req, res, req.body));
    // Stateless: there are no sessions to end and nothing to push on a standalone stream. Saying so
    // (405) stops clients from holding a GET stream open; when that idle stream broke (helper
    // restart, sleep, WSL network reset), clients retried twice and then marked the server failed.
    const noStream = (_req: Request, res: Response): void => {
      res.set("Allow", "POST");
      rpcError(res, 405, -32000, "method not allowed: this server is stateless; use POST");
    };
    app.get("/mcp", guard, auth, noStream);
    app.delete("/mcp", guard, auth, noStream);

    // Body-parser and other errors: answer in JSON-RPC, never with a stack trace.
    app.use((err: { type?: string; status?: number }, _req: Request, res: Response, next: NextFunction) => {
      if (res.headersSent) return next(err);
      if (err?.type === "entity.parse.failed") return rpcError(res, 400, -32700, "parse error: body is not valid JSON");
      if (err?.type === "entity.too.large" || err?.status === 413) {
        return rpcError(res, 413, -32600, "request body too large (limit 2 MB)");
      }
      console.error(`[webmcp] HTTP error: ${String(err)}`);
      rpcError(res, 500, -32603, "internal error");
    });
    return app;
  }
}
