/**
 * Shared helpers for MCP tool implementations.
 *
 * Individual tool modules (tabs.ts, understand.ts, act.ts, browser.ts)
 * build on these so formatting / error handling stays uniform.
 */

import { z } from "zod";
import type { BridgeMethod } from "@webmcp-controller/shared";
import { BridgeError, type ExtensionBridge } from "../bridge/bridge.js";
import type { ServerConfig } from "../config.js";

const DEFAULT_MAX_TEXT = 20000;

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen)}\n… [truncated ${s.length - maxLen} chars]`;
}

/** Render a bridge result as display text. Long output is truncated with a notice. */
export function fmt(res: unknown, maxLen = DEFAULT_MAX_TEXT): string {
  if (typeof res === "string") return truncate(res, maxLen);
  if (
    res !== null &&
    typeof res === "object" &&
    "text" in res &&
    typeof (res as { text: unknown }).text === "string" &&
    Object.keys(res).length === 1
  ) {
    return truncate((res as { text: string }).text, maxLen);
  }
  try {
    return truncate(JSON.stringify(res ?? null, null, 2), maxLen);
  } catch {
    return truncate(String(res), maxLen);
  }
}

/** Normalize any thrown value into a { code, message } pair. */
export function toBridgeError(e: unknown): { code: string; message: string } {
  if (e instanceof BridgeError) return { code: e.code, message: e.message };
  if (e instanceof Error) return { code: "UNKNOWN", message: e.message };
  return { code: "UNKNOWN", message: String(e) };
}

/**
 * Destructive-action guard. Returns an error message when the action must be
 * refused (caller should surface it as a tool error), else null.
 */
export function requireConfirm(
  config: ServerConfig,
  confirmed: boolean | undefined,
  action: string,
): string | null {
  if (config.confirmDestructive && !confirmed) {
    return (
      `Refused ${action}: destructive action requires explicit confirm:true ` +
      `(pass confirm:true to proceed; the user can turn this guard off in the add-on settings).`
    );
  }
  return null;
}

/** Optional Firefox tab id; when omitted the extension uses the active tab. */
export const tabIdField = z
  .number()
  .int()
  .positive()
  .optional()
  .describe("Firefox tab id; defaults to active tab");

/**
 * Call the extension over the bridge and format the result as text.
 * Bridge failures are returned as `ERROR [CODE]: message` text, never thrown.
 */
export async function callBridge(
  bridge: ExtensionBridge,
  method: BridgeMethod,
  params: Record<string, unknown> = {},
  opts?: { timeoutMs?: number },
): Promise<string> {
  try {
    const result = await bridge.call(method, params, opts);
    return fmt(result);
  } catch (e) {
    const { code, message } = toBridgeError(e);
    return `ERROR [${code}]: ${message}`;
  }
}
