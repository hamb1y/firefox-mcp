/**
 * Shared wire protocol between the Firefox WebExtension and the native host
 * (webmcp-host), which Firefox launches via native messaging and which
 * serves MCP over HTTP to the harness.
 *
 * Transport: native messaging stdio (uint32 length prefix + UTF-8 JSON).
 * Shapes:
 *   1. Command   ext <- server : { id, method, params }        (server initiates)
 *   2. Response  ext -> server : { id, ok, result?, error? }   (extension answers)
 *   3. Event     ext -> server : { event, data }               (unsolicited push)
 *   4. Hello     ext -> server : { hello }                     (first message after connect)
 *   5. Config    ext -> host   : { hostConfig }                (start/restart the MCP HTTP listener)
 *   6. Status    host -> ext   : { hostStatus }                (listener state, sent on every change)
 *   7. Exit      host -> ext   : { hostExit }                  (helper is about to quit, e.g. it was updated)
 *
 * Versioning: PROTOCOL is bumped only for breaking wire changes. Both sides
 * announce it (hello.protocol / hostStatus.protocol); the add-on refuses to
 * drive a helper with a different PROTOCOL and asks the user to update the
 * older side. Product versions (VERSION) may differ freely within a PROTOCOL.
 *
 * Timeouts: server waits CMD_TIMEOUT_MS (30s) per command, then rejects.
 * Refs: an AX snapshot ref names one element for the life of the document and
 * is never reused. Passing the snapshot's `generation` with an action makes the
 * extension refuse refs from a different page load (REF_STALE).
 * Cancel: the host may send `{cancel: id}` to abandon a pending command.
 */

// ---------------------------------------------------------------- hello ---

export interface HelloMessage {
  hello: {
    extensionId: string;
    version: string;
    /** Wire protocol the add-on speaks. Absent = 1. */
    protocol?: number;
    token: string;
    profile: string; // e.g. "default-release"
    firefoxVersion: string;
    capabilities: string[];
  };
}

// -------------------------------------------------------------- command ---

export type BridgeMethod =
  // inventory
  | "tabs.list"
  | "tabs.query"
  | "windows.list"
  | "active.tab"
  // tab/window management
  | "tab.create"
  | "tab.update"
  | "tab.close"
  | "tab.duplicate"
  | "tab.move"
  | "tab.pin"
  | "tab.unpin"
  | "tab.mute"
  | "window.create"
  | "window.focus"
  | "window.remove"
  // navigation
  | "nav.back"
  | "nav.forward"
  | "nav.reload"
  // understanding
  | "page.snapshot"
  | "page.text"
  | "page.html"
  | "page.shot"
  | "page.info"
  // acting (all take an optional tabId; default = active tab)
  | "act.click"
  | "act.type"
  | "act.fillForm"
  | "act.select"
  | "act.hover"
  | "act.scroll"
  | "act.key"
  | "act.wait"
  | "act.find"
  // browser data
  | "bookmarks.search"
  | "bookmarks.create"
  | "bookmarks.remove"
  | "history.search"
  | "downloads.list"
  | "cookies.forTab"
  | "sessions.recentlyClosed"
  | "sessions.restore"
  | "cursor.say";

export interface BridgeCommand {
  id: string;
  method: BridgeMethod;
  params: Record<string, unknown>;
}

export interface BridgeResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

// ---------------------------------------------------------------- event ---

export type BridgeEventType =
  | "tab.updated"
  | "tab.removed"
  | "tab.activated"
  | "download.done"
  | "extension.ready";

export interface BridgeEvent {
  event: BridgeEventType;
  data: Record<string, unknown>;
}

/** Host → extension: stop working on command `cancel` (its response is ignored). */
export interface CancelMessage {
  cancel: string;
}

export type WireMessage = BridgeCommand | BridgeResponse | BridgeEvent | HelloMessage | CancelMessage;

// ------------------------------------------------------------ ax snapshot ---

/** One node of the accessibility snapshot. `ref` is unique within the document. */
export interface AxNode {
  ref: number;
  role: string;
  name: string;
  value?: string;
  checked?: boolean | "mixed";
  disabled?: boolean;
  readonly?: boolean;
  selected?: boolean;
  expanded?: boolean;
  level?: number;
  children?: AxNode[];
}

export interface AxSnapshot {
  generation: string; // identifies the page load this snapshot came from
  url: string;
  title: string;
  truncated: boolean;
  nodes: AxNode[];
  /** Flattened human-readable rendering, Playwright-style: `[ref=3] button "Send" [disabled]` */
  text: string;
}

// ----------------------------------------------------------------- tabs ---

export interface TabInfo {
  id: number;
  windowId: number;
  index: number;
  url: string;
  title: string;
  active: boolean;
  pinned: boolean;
  audible: boolean;
  muted: boolean;
  discarded: boolean;
  loading: boolean;
}

export interface WindowInfo {
  id: number;
  focused: boolean;
  incognito: boolean;
  type: string;
  tabCount: number;
}

// ---------------------------------------------------------------- errors ---

/** Firefox rejects native messages from the host larger than this. */
export const MAX_HOST_MESSAGE_BYTES = 1024 * 1024;

export const BRIDGE_ERRORS = {
  NO_CONTENT_SCRIPT: "NO_CONTENT_SCRIPT", // page has no injected script (chrome://, about:, AMO)
  RESTRICTED_PAGE: "RESTRICTED_PAGE", // scripting forbidden by Firefox
  REF_STALE: "REF_STALE", // ref/generation from another page load, or element removed
  REF_NOT_FOUND: "REF_NOT_FOUND", // ref id unknown on this page
  TAB_NOT_FOUND: "TAB_NOT_FOUND",
  INVALID_PARAMS: "INVALID_PARAMS", // missing/malformed command params
  UNKNOWN_METHOD: "UNKNOWN_METHOD", // no such bridge method
  NOT_SUPPORTED: "NOT_SUPPORTED", // API missing in this browser build
  INTERNAL: "INTERNAL", // unclassified extension/content error
  TIMEOUT: "TIMEOUT",
  NOT_CONNECTED: "NOT_CONNECTED",
  EXTENSION_BUSY: "EXTENSION_BUSY", // another harness holds the extension lock
  ELEMENT_DISABLED: "ELEMENT_DISABLED", // target is disabled
  NOT_EDITABLE: "NOT_EDITABLE", // target can't take typed text (button, read-only…)
  NO_MATCH: "NO_MATCH", // no <option> matches the requested value
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE", // command exceeds the native-messaging limit
  CANCELLED: "CANCELLED", // the MCP client cancelled the request
  PROTOCOL_MISMATCH: "PROTOCOL_MISMATCH", // add-on and helper speak different PROTOCOLs
} as const;

// ----------------------------------------------------------- host config ---

export interface HostConfigMessage {
  hostConfig: {
    /** Bearer token the harness must present on /mcp. */
    token: string;
    /** HTTP port for MCP. Default 8901. */
    port: number;
    /** Listen address. Default 127.0.0.1; 0.0.0.0 exposes it to the LAN/WSL NAT. */
    bind: string;
    /** Require confirm:true for destructive tools. Default true. */
    confirmDestructive?: boolean;
    /** Windows only: also listen on the WSL virtual adapter so a harness inside WSL can connect. */
    allowWsl?: boolean;
  };
}

export interface HostStatusMessage {
  hostStatus: {
    version: string;
    protocol: number;
    platform: string;
    listening: boolean;
    url: string;
    /** Extra listener URLs (e.g. the WSL adapter address), reachable from elsewhere. */
    extraUrls: string[];
    /** Windows host address as seen from WSL, when the WSL adapter exists. */
    wslAddress: string;
    port: number;
    bind: string;
    error: string;
    /** MCP requests served since the host started. */
    requests: number;
  };
}

export interface HostExitMessage {
  hostExit: { reason: "updated" | "shutdown"; version?: string };
}

export function isHostConfig(m: unknown): m is HostConfigMessage {
  return typeof m === "object" && m !== null && "hostConfig" in m;
}

export const NATIVE_HOST_NAME = "webmcp_controller";

export const CMD_TIMEOUT_MS = 30_000;
/** Breaking wire-protocol version; keep in sync with PROTOCOL in extension/background.js. */
export const PROTOCOL = 1;
export { VERSION } from "./version.js";

export function isHello(m: unknown): m is HelloMessage {
  return typeof m === "object" && m !== null && "hello" in m;
}
export function isResponse(m: unknown): m is BridgeResponse {
  return (
    typeof m === "object" &&
    m !== null &&
    "id" in m &&
    "ok" in m &&
    !("method" in m)
  );
}
export function isEvent(m: unknown): m is BridgeEvent {
  return typeof m === "object" && m !== null && "event" in m;
}
