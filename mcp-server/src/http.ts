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

export class McpHttp {
  private servers: Server[] = [];
  private config: ServerConfig | null = null;
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

  constructor(private bridge: ExtensionBridge) {}

  get status(): HttpState {
    return { ...this.state };
  }

  /** (Re)start with new settings. No-op if nothing that affects the socket changed. */
  async apply(config: ServerConfig): Promise<void> {
    const prev = this.config;
    this.config = config; // token/confirm changes take effect on the next request
    if (
      prev &&
      this.servers.length &&
      prev.port === config.port &&
      prev.bind === config.bind &&
      prev.allowWsl === config.allowWsl
    ) {
      this.emit();
      return;
    }
    await this.stop();
    await this.listen(config);
  }

  async stop(): Promise<void> {
    const servers = this.servers;
    this.servers = [];
    this.state.listening = false;
    await Promise.all(
      servers.map(
        (srv) =>
          new Promise<void>((resolve) => {
            srv.close(() => resolve());
            srv.closeAllConnections?.();
          }),
      ),
    );
  }

  private emit(): void {
    this.onChange?.(this.status);
  }

  private async listen(config: ServerConfig): Promise<void> {
    const app = this.buildApp();
    const wildcard = config.bind === "0.0.0.0" || config.bind === "::";
    // 127.0.0.1, not "localhost": some clients resolve localhost to ::1 first.
    const host = wildcard ? "127.0.0.1" : config.bind;
    const wsl = wslAddresses();
    const extra = config.allowWsl && !wildcard ? wsl.filter((a) => a !== config.bind) : [];
    this.state = {
      ...this.state,
      listening: false,
      port: config.port,
      bind: config.bind,
      url: urlFor(host, config.port),
      extraUrls: [],
      wslAddress: wsl[0] ?? "",
      error: "",
    };

    const err = await this.listenOne(app, config.port, config.bind);
    if (err) {
      this.state.error = err;
      console.error(`[webmcp] ${err}`);
      this.emit();
      return;
    }
    this.state.listening = true;
    if (wildcard && config.allowWsl) this.state.extraUrls = wsl.map((a) => urlFor(a, config.port));
    for (const addr of extra) {
      const e = await this.listenOne(app, config.port, addr);
      if (e) console.error(`[webmcp] WSL listener: ${e}`);
      else this.state.extraUrls.push(urlFor(addr, config.port));
    }
    this.emit();
  }

  /** Listen on one address; resolves to a human-readable error, or "" on success. */
  private listenOne(app: express.Express, port: number, bind: string): Promise<string> {
    const srv = createServer(app);
    return new Promise((resolve) => {
      srv.once("error", (err: NodeJS.ErrnoException) => {
        resolve(
          err.code === "EADDRINUSE"
            ? `Port ${port} is already in use (another Firefox profile, or another app). Pick a different port in settings.`
            : err.code === "EADDRNOTAVAIL"
              ? `Address ${bind} doesn't exist on this machine.`
              : err.code === "EACCES"
                ? `Not allowed to listen on ${bind}:${port}.`
                : `Listen failed: ${err.message}`,
        );
      });
      srv.listen(port, bind, () => {
        this.servers.push(srv);
        console.error(`[webmcp] MCP listening on ${bind}:${port}`);
        resolve("");
      });
    });
  }

  private buildApp(): express.Express {
    const app = express();
    app.use(express.json({ limit: "10mb" }));

    const auth = (req: Request, res: Response, next: NextFunction): void => {
      const header = req.headers.authorization ?? "";
      const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
      if (!this.config || !tokensEqual(presented, this.config.token)) {
        res.status(401).json({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32001, message: "unauthorized: missing or invalid bearer token" },
        });
        return;
      }
      next();
    };

    app.get("/health", (_req: Request, res: Response) => {
      res.json({ ok: true, extensionConnected: this.bridge.connected, version: SERVER_VERSION });
    });

    app.get("/", (_req: Request, res: Response) => {
      res
        .type("text")
        .send(
          `webmcp-controller ${SERVER_VERSION}\nextension: ${this.bridge.connected ? "connected" : "disconnected"}\n` +
            `MCP endpoint: POST /mcp (Streamable HTTP, Authorization: Bearer <token from the add-on popup>)\n`,
        );
    });

    const handle = async (req: Request, res: Response, body?: unknown): Promise<void> => {
      this.state.requests += 1;
      try {
        // Stateless: one McpServer + transport per request.
        const server = new McpServer(
          { name: "webmcp-controller", version: SERVER_VERSION },
          { instructions: SERVER_INSTRUCTIONS },
        );
        registerFirefoxTools(server, this.bridge, this.config!);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on("close", () => {
          void transport.close().catch(() => {});
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch (err) {
        console.error(`[webmcp] MCP request failed: ${String(err)}`);
        if (!res.headersSent) {
          res.status(500).json({ jsonrpc: "2.0", id: null, error: { code: -32603, message: "internal error" } });
        }
      }
    };

    app.post("/mcp", auth, (req: Request, res: Response) => void handle(req, res, req.body));
    app.get("/mcp", auth, (req: Request, res: Response) => void handle(req, res));
    app.delete("/mcp", auth, (req: Request, res: Response) => void handle(req, res));
    return app;
  }
}
