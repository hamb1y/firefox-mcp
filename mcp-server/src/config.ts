/** Runtime configuration, pushed by the extension in a hostConfig message. */
export interface ServerConfig {
  /** Port for the MCP Streamable-HTTP endpoint. Default 8901. */
  port: number;
  /** Listen address. Default 127.0.0.1. */
  bind: string;
  /** Bearer token required from MCP clients. */
  token: string;
  /** If true, destructive ops (window close, mass tab close) need explicit confirm:true. Default true. */
  confirmDestructive: boolean;
  /** Per-command timeout ms for extension round-trips. Default 30000. */
  cmdTimeoutMs: number;
  /** Windows: also listen on the WSL adapter address(es). */
  allowWsl: boolean;
}

export const DEFAULT_PORT = 8901;
export const DEFAULT_BIND = "127.0.0.1";
