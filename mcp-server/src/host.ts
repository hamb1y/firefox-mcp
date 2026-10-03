/**
 * firefox-mcp-host: the native messaging host for the Firefox MCP Bridge add-on.
 *
 * Two modes, one binary:
 *  - Launched by Firefox (argv = [manifestPath, extensionId], stdin is a pipe):
 *    speaks native messaging on stdin/stdout to the extension and serves MCP
 *    over HTTP to the harness. Exits when Firefox closes stdin.
 *  - Run by a person: `install` (default when double-clicked), `uninstall`, `status`.
 *
 * stdout is the native messaging channel, so nothing else may ever write to it.
 */

// Must run before anything logs: route all console output to stderr
// (Firefox shows host stderr in the Browser Console).
console.log = console.error;
console.info = console.error;
console.warn = console.error;
console.debug = console.error;

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import {
  isHello,
  isHostConfig,
  NATIVE_HOST_NAME,
  PROTOCOL,
  type HostExitMessage,
  type HostStatusMessage,
} from "@firefox-mcp/shared";
import { ExtensionBridge } from "./bridge/bridge.js";
import { DEFAULT_BIND, DEFAULT_PORT } from "./config.js";
import { McpHttp, SERVER_VERSION } from "./http.js";

const EXTENSION_ID = "firefox-mcp@hamb1y.github.io";
/** IDs of older add-on builds, still allowed so an un-updated add-on gets "update me" instead of "not installed". */
const LEGACY_EXTENSION_IDS = ["firefox-mcp-bridge@example.com"];
const MAX_OUT = 1024 * 1024; // Firefox rejects host->extension messages over 1 MB

// ===================================================================== host

function runHost(): void {
  process.on("uncaughtException", (e) => console.error(`[firefox-mcp] uncaught: ${e?.stack ?? e}`));
  process.on("unhandledRejection", (e) => console.error(`[firefox-mcp] unhandled: ${String(e)}`));

  const write = (obj: unknown): void => {
    const body = Buffer.from(JSON.stringify(obj), "utf8");
    if (body.length > MAX_OUT) {
      console.error(`[firefox-mcp] dropping ${body.length}-byte message to extension (over 1 MB)`);
      return;
    }
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length, 0);
    process.stdout.write(Buffer.concat([header, body]));
  };

  const bridge = new ExtensionBridge();
  const http = new McpHttp(bridge);
  const link = { send: write };

  const sendStatus = (): void => {
    const s = http.status;
    const msg: HostStatusMessage = {
      hostStatus: { version: SERVER_VERSION, protocol: PROTOCOL, platform: process.platform, ...s },
    };
    write(msg);
  };
  http.onChange = sendStatus;
  bridge.onStatusChange = (connected, info) => {
    console.error(
      `[firefox-mcp] extension ${connected ? `connected (v${info?.version}, Firefox ${info?.firefoxVersion})` : "disconnected"}`,
    );
  };

  const onMessage = (msg: unknown): void => {
    if (isHello(msg)) {
      const p = msg.hello.protocol ?? 1;
      if (p !== PROTOCOL) console.error(`[firefox-mcp] add-on speaks protocol ${p}, this helper speaks ${PROTOCOL}`);
      bridge.connect(link, msg.hello);
      sendStatus();
      return;
    }
    if (isHostConfig(msg)) {
      const c = msg.hostConfig;
      const port = Number.isInteger(c.port) && c.port > 0 && c.port < 65536 ? c.port : DEFAULT_PORT;
      const bind = typeof c.bind === "string" && c.bind.trim() ? c.bind.trim() : DEFAULT_BIND;
      if (typeof c.token !== "string" || c.token.length < 16) {
        console.error("[firefox-mcp] refusing hostConfig without a token of at least 16 chars");
        return;
      }
      void http.apply({
        port,
        bind,
        token: c.token,
        confirmDestructive: c.confirmDestructive !== false,
        cmdTimeoutMs: 30_000,
        allowWsl: c.allowWsl === true,
      });
      return;
    }
    bridge.receive(msg);
  };

  // Native messaging framing: uint32 (native endian = LE everywhere we ship) + UTF-8 JSON.
  let buf: Buffer = Buffer.alloc(0);
  process.stdin.on("data", (chunk: Buffer) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) break;
      const body = buf.subarray(4, 4 + len).toString("utf8");
      buf = buf.subarray(4 + len);
      let msg: unknown;
      try {
        msg = JSON.parse(body);
      } catch {
        console.error("[firefox-mcp] ignoring non-JSON message from extension");
        continue;
      }
      onMessage(msg);
    }
  });

  const shutdown = (): void => {
    bridge.disconnect();
    void http.stop().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // When `install` replaces the binary we're running from, tell the add-on and
  // exit so it relaunches the new version straight away.
  if (isCompiled()) {
    const exe = process.execPath;
    const before = fs.statSync(exe, { throwIfNoEntry: false });
    fs.watchFile(exe, { interval: 2000, persistent: false }, (cur) => {
      if (before && cur.mtimeMs === before.mtimeMs && cur.ino === before.ino && cur.size === before.size) return;
      if (cur.size === 0) return; // mid-write; wait for the next tick
      console.error("[firefox-mcp] helper binary was replaced; exiting so Firefox starts the new one");
      const bye: HostExitMessage = { hostExit: { reason: "updated" } };
      write(bye);
      shutdown();
    });
  }

  console.error(`[firefox-mcp] host ${SERVER_VERSION} started (pid ${process.pid})`);
}

// ================================================================ installer

type Platform = "win" | "mac" | "linux";

function platform(): Platform {
  if (process.platform === "win32") return "win";
  if (process.platform === "darwin") return "mac";
  return "linux";
}

function installDir(): string {
  const home = os.homedir();
  switch (platform()) {
    case "win":
      return path.join(process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "firefox-mcp");
    case "mac":
      return path.join(home, "Library", "Application Support", "firefox-mcp");
    default:
      return path.join(process.env.XDG_DATA_HOME ?? path.join(home, ".local", "share"), "firefox-mcp");
  }
}

/** Where Firefox looks for the host manifest (Windows uses the registry instead). */
function manifestDirs(): string[] {
  const home = os.homedir();
  if (platform() === "mac") {
    return [path.join(home, "Library", "Application Support", "Mozilla", "NativeMessagingHosts")];
  }
  if (platform() === "linux") {
    const dirs = [path.join(home, ".mozilla", "native-messaging-hosts")];
    const xdg = process.env.XDG_CONFIG_HOME ?? path.join(home, ".config");
    dirs.push(path.join(xdg, "mozilla", "native-messaging-hosts"));
    // Snap Firefox reads from its own confined home.
    if (fs.existsSync(path.join(home, "snap", "firefox"))) {
      dirs.push(path.join(home, "snap", "firefox", "common", ".mozilla", "native-messaging-hosts"));
    }
    return dirs;
  }
  return [];
}

const REG_KEY = `HKCU\\Software\\Mozilla\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`;

/** True when running as a bun-compiled single binary (vs `node dist/host.js`). */
function isCompiled(): boolean {
  return !/(^|[\\/])(node|bun|nodejs)(\.exe)?$/i.test(process.execPath);
}

/**
 * Copy this binary to dest without ever leaving a half-written file at dest:
 * write next to it, then rename over. On Windows a running exe can't be
 * replaced but can be renamed away, so move the old one aside first.
 */
function copySelf(dest: string): void {
  const src = process.execPath;
  if (path.resolve(src).toLowerCase() === path.resolve(dest).toLowerCase()) return;
  const tmp = `${dest}.new-${process.pid}`;
  fs.copyFileSync(src, tmp);
  if (platform() !== "win") fs.chmodSync(tmp, 0o755);
  if (platform() === "mac") spawnSync("xattr", ["-d", "com.apple.quarantine", tmp], { stdio: "ignore" });
  try {
    fs.renameSync(tmp, dest);
  } catch (e) {
    if (platform() !== "win" || !fs.existsSync(dest)) {
      fs.rmSync(tmp, { force: true });
      throw e;
    }
    fs.renameSync(dest, `${dest}.old-${Date.now()}`);
    fs.renameSync(tmp, dest);
  }
}

function cleanupOld(dir: string): void {
  for (const f of fs.readdirSync(dir)) {
    if (/\.(old|new)-\d+$/.test(f)) {
      try {
        fs.unlinkSync(path.join(dir, f));
      } catch {
        /* still in use; next time */
      }
    }
  }
}

/** Put the host somewhere stable and return the path Firefox should execute. */
function installExecutable(dir: string): string {
  const win = platform() === "win";
  if (isCompiled()) {
    const dest = path.join(dir, win ? "firefox-mcp-host.exe" : "firefox-mcp-host");
    copySelf(dest);
    return dest;
  }
  // Dev install: `node dist/host.js install` → launcher script pointing at this checkout.
  const script = path.resolve(process.argv[1] ?? "");
  if (win) {
    const dest = path.join(dir, "firefox-mcp-host.bat");
    fs.writeFileSync(dest, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
    return dest;
  }
  const dest = path.join(dir, "firefox-mcp-host.sh");
  fs.writeFileSync(dest, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  fs.chmodSync(dest, 0o755);
  return dest;
}

function hostManifest(exe: string, extensionId: string): string {
  return JSON.stringify(
    {
      name: NATIVE_HOST_NAME,
      description: "Firefox MCP Bridge host: serves MCP to your local AI tools",
      path: exe,
      type: "stdio",
      allowed_extensions: [extensionId, ...LEGACY_EXTENSION_IDS.filter((id) => id !== extensionId)],
    },
    null,
    2,
  );
}

function install(extensionId: string): void {
  const dir = installDir();
  fs.mkdirSync(dir, { recursive: true });
  cleanupOld(dir);
  const exe = installExecutable(dir);
  const manifest = hostManifest(exe, extensionId);
  const written: string[] = [];

  if (platform() === "win") {
    const file = path.join(dir, `${NATIVE_HOST_NAME}.json`);
    fs.writeFileSync(file, manifest);
    written.push(file);
    const r = spawnSync("reg", ["add", REG_KEY, "/ve", "/t", "REG_SZ", "/d", file, "/f"], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`registry write failed: ${r.stderr || r.stdout || r.error}`);
    written.push(`registry ${REG_KEY}`);
  } else {
    for (const d of manifestDirs()) {
      fs.mkdirSync(d, { recursive: true });
      const file = path.join(d, `${NATIVE_HOST_NAME}.json`);
      fs.writeFileSync(file, manifest);
      written.push(file);
    }
  }

  console.error(`\nFirefox MCP Bridge host ${SERVER_VERSION} installed.\n`);
  console.error(`  program:  ${exe}`);
  for (const w of written) console.error(`  manifest: ${w}`);
  console.error(`\nDone. The Firefox MCP Bridge toolbar icon turns green within a few seconds`);
  console.error(`(open its popup to make it instant), then use "Copy MCP config" there.`);
  console.error(`If Firefox was already running an older helper, it switches to this one automatically.\n`);
}

function uninstall(): void {
  const removed: string[] = [];
  if (platform() === "win") {
    const r = spawnSync("reg", ["delete", REG_KEY, "/f"], { encoding: "utf8" });
    if (r.status === 0) removed.push(`registry ${REG_KEY}`);
  } else {
    for (const d of manifestDirs()) {
      const file = path.join(d, `${NATIVE_HOST_NAME}.json`);
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
        removed.push(file);
      }
    }
  }
  const dir = installDir();
  if (fs.existsSync(dir)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
    } catch {
      console.error(`Could not delete ${dir} (in use?) — quit Firefox and delete it by hand.`);
    }
  }
  console.error(removed.length ? `Removed:\n  ${removed.join("\n  ")}` : "Nothing to remove.");
}

function status(): void {
  console.error(`firefox-mcp-host ${SERVER_VERSION} (${process.platform}/${process.arch}, ${isCompiled() ? "binary" : "node"})`);
  console.error(`install dir: ${installDir()}`);
  if (platform() === "win") {
    const r = spawnSync("reg", ["query", REG_KEY, "/ve"], { encoding: "utf8" });
    console.error(r.status === 0 ? `registry: ${r.stdout.trim().split(/\r?\n/).pop()}` : "registry: NOT registered");
  } else {
    for (const d of manifestDirs()) {
      const file = path.join(d, `${NATIVE_HOST_NAME}.json`);
      console.error(`${fs.existsSync(file) ? "ok     " : "missing"} ${file}`);
    }
  }
}

function usage(): void {
  console.error(`firefox-mcp-host ${SERVER_VERSION}

Usage:
  firefox-mcp-host install [--extension-id ID]   register with Firefox (default when double-clicked)
  firefox-mcp-host uninstall                     remove registration and files
  firefox-mcp-host status                        show what's installed where
`);
}

async function pauseIfDoubleClicked(): Promise<void> {
  // A double-clicked console window would vanish before anyone could read it.
  if (platform() !== "win" || !process.stdin.isTTY) return;
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  await new Promise<void>((resolve) => rl.question("Press Enter to close…", () => resolve()));
  rl.close();
}

// ==================================================================== main

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];

  // Firefox: argv = [path/to/manifest.json, extension-id]
  if (cmd?.toLowerCase().endsWith(".json") || (!cmd && !process.stdin.isTTY)) {
    runHost();
    return;
  }

  const idFlag = args.indexOf("--extension-id");
  const extensionId = idFlag >= 0 && args[idFlag + 1] ? args[idFlag + 1]! : EXTENSION_ID;
  try {
    switch (cmd ?? "install") {
      case "install":
        install(extensionId);
        break;
      case "uninstall":
        uninstall();
        break;
      case "status":
        status();
        break;
      case "--version":
      case "version":
        console.error(SERVER_VERSION);
        break;
      default:
        usage();
        process.exitCode = cmd === "help" || cmd === "--help" || cmd === "-h" ? 0 : 2;
    }
  } catch (e) {
    console.error(`\nERROR: ${(e as Error).message ?? e}`);
    process.exitCode = 1;
  }
  if (!cmd) await pauseIfDoubleClicked();
}

void main();
