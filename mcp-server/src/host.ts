/**
 * webmcp-host: the native messaging host for the WebMCP Controller add-on.
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
  MAX_HOST_MESSAGE_BYTES,
  NATIVE_HOST_NAME,
  PROTOCOL,
  type HostExitMessage,
  type HostStatusMessage,
} from "@webmcp-controller/shared";
import { ExtensionBridge } from "./bridge/bridge.js";
import { DEFAULT_BIND, DEFAULT_PORT } from "./config.js";
import { McpHttp, SERVER_VERSION } from "./http.js";

const EXTENSION_ID = "webmcp-controller@hamb1y.github.io";
/** Pre-0.3.4 native host name; its registration is removed on install so stale helpers can't be launched. */
const LEGACY_HOST_NAME = "firefox_mcp_bridge";

// ===================================================================== host

/** Largest extension -> helper message we'll buffer (screenshots of huge pages are well under this). */
const MAX_FRAME_BYTES = 64 * 1024 * 1024;

/** Max log size before it's rotated to webmcp-host.log.1. */
const LOG_MAX_BYTES = 512 * 1024;

/**
 * Copy everything the helper prints (it all goes to stderr) into a log file next to it,
 * so a helper that stopped can say why after the fact. Returns the path, or "" if unwritable.
 */
function startLog(): string {
  let file = "";
  let size = 0;
  try {
    const dir = installDir();
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, "webmcp-host.log");
    size = fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0;
    if (size > LOG_MAX_BYTES) {
      fs.renameSync(file, `${file}.1`);
      size = 0;
    }
    fs.appendFileSync(file, "");
  } catch {
    return "";
  }
  const stderr = console.error.bind(console);
  let broken = false;
  console.error = (...args: unknown[]): void => {
    stderr(...args);
    if (broken) return;
    try {
      const line = args.map((a) => (typeof a === "string" ? a : a instanceof Error ? a.stack : String(a))).join(" ");
      const text = `${new Date().toISOString()} [${process.pid}] ${line}\n`;
      // A helper can run for weeks: rotate while running too, not just at start.
      if (size + text.length > LOG_MAX_BYTES) {
        try {
          fs.renameSync(file, `${file}.1`);
        } catch {
          /* another helper rotated it first */
        }
        size = 0;
      }
      fs.appendFileSync(file, text);
      size += Buffer.byteLength(text);
    } catch {
      broken = true; // disk full, folder deleted: keep running, just stop logging
    }
  };
  console.log = console.info = console.warn = console.debug = console.error;
  return file;
}

/** Ask a helper binary its version; "" if it can't be run (mid-copy, locked by a virus scan, gone). */
function binaryVersion(exe: string): string {
  const r = spawnSync(exe, ["--version"], { encoding: "utf8", timeout: 15_000, windowsHide: true });
  if (r.status !== 0) return "";
  const m = /\d+\.\d+\.\d+\S*/.exec(`${r.stderr ?? ""}${r.stdout ?? ""}`);
  return m ? m[0] : "";
}

/** Is a process still running? Only a definite "no such process" counts as gone. */
function processGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ESRCH";
  }
}

function runHost(): void {
  const startedAt = Date.now();
  const logFile = startLog();
  process.on("uncaughtException", (e) => console.error(`[webmcp] uncaught: ${e?.stack ?? e}`));
  process.on("unhandledRejection", (e) => console.error(`[webmcp] unhandled: ${String(e)}`));

  let exiting = false;
  const write = (obj: unknown): void => {
    if (exiting && !("hostExit" in (obj as object))) return;
    const body = Buffer.from(JSON.stringify(obj), "utf8");
    if (body.length > MAX_HOST_MESSAGE_BYTES) {
      // Callers check first (bridge.call -> PAYLOAD_TOO_LARGE); this is the backstop.
      throw new Error(`message to extension is ${body.length} bytes (Firefox's limit is 1 MB)`);
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
      hostStatus: { version: SERVER_VERSION, protocol: PROTOCOL, platform: process.platform, ...s, startedAt, logFile },
    };
    write(msg);
  };
  http.onChange = sendStatus;
  bridge.onStatusChange = (connected, info) => {
    console.error(
      `[webmcp] extension ${connected ? `connected (v${info?.version}, Firefox ${info?.firefoxVersion})` : "disconnected"}`,
    );
  };

  const onMessage = (msg: unknown): void => {
    if (isHello(msg)) {
      const p = msg.hello.protocol ?? 1;
      let refuse: { code: string; message: string } | undefined;
      if (p !== PROTOCOL) {
        const older = p < PROTOCOL ? "the WebMCP Controller add-on" : "the helper app (rerun the install command from the add-on popup)";
        refuse = {
          code: "PROTOCOL_MISMATCH",
          message: `add-on speaks protocol ${p}, helper ${SERVER_VERSION} speaks ${PROTOCOL}: update ${older}`,
        };
        console.error(`[webmcp] ${refuse.message}`);
      }
      bridge.connect(link, msg.hello, refuse);
      sendStatus();
      return;
    }
    if (isHostConfig(msg)) {
      const c = msg.hostConfig;
      const port = Number.isInteger(c.port) && c.port > 0 && c.port < 65536 ? c.port : DEFAULT_PORT;
      const bind = typeof c.bind === "string" && c.bind.trim() ? c.bind.trim() : DEFAULT_BIND;
      if (typeof c.token !== "string" || c.token.length < 16) {
        console.error("[webmcp] refusing hostConfig without a token of at least 16 chars");
        return;
      }
      http.apply({
        port,
        bind,
        token: c.token,
        confirmDestructive: c.confirmDestructive !== false,
        cmdTimeoutMs: 30_000,
        allowWsl: c.allowWsl === true,
      }).catch((e) => console.error(`[webmcp] applying settings failed: ${String(e)}`));
      return;
    }
    bridge.receive(msg);
  };

  // Native messaging framing: uint32 (native endian = LE everywhere we ship) + UTF-8 JSON.
  let buf: Buffer = Buffer.alloc(0);
  /** Bytes still to drop from a frame that was too big to buffer. */
  let skip = 0;
  process.stdin.on("data", (chunk: Buffer) => {
    if (skip) {
      const n = Math.min(skip, chunk.length);
      skip -= n;
      chunk = chunk.subarray(n);
      if (!chunk.length) return;
    }
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (len > MAX_FRAME_BYTES) {
        console.error(`[webmcp] dropping a ${len}-byte message from the extension (limit ${MAX_FRAME_BYTES})`);
        const have = Math.min(buf.length - 4, len);
        skip = len - have;
        buf = buf.subarray(4 + have);
        continue;
      }
      if (buf.length < 4 + len) break;
      const body = buf.subarray(4, 4 + len).toString("utf8");
      buf = buf.subarray(4 + len);
      let msg: unknown;
      try {
        msg = JSON.parse(body);
      } catch {
        console.error("[webmcp] ignoring non-JSON message from extension");
        continue;
      }
      // One bad message must not take the rest of the stream down with it.
      try {
        onMessage(msg);
      } catch (e) {
        console.error(`[webmcp] failed to handle a message from the extension: ${String(e)}`);
      }
    }
  });

  const shutdown = (why: string): void => {
    if (exiting) return;
    exiting = true;
    console.error(`[webmcp] exiting: ${why} (up ${Math.round((Date.now() - startedAt) / 1000)}s)`);
    bridge.disconnect();
    void http.stop().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  // Firefox closed the pipe: the add-on was disabled, reloaded or updated, or Firefox quit.
  process.stdin.on("end", () => shutdown("Firefox closed the connection"));
  process.stdin.on("close", () => shutdown("Firefox closed the connection"));
  process.stdin.on("error", (e) => shutdown(`reading from Firefox failed: ${e.message}`));
  // Without this, a broken pipe would leave a headless helper holding the port.
  process.stdout.on("error", (e) => shutdown(`writing to Firefox failed: ${e.message}`));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Backstop for a parent that died without closing our pipe: never outlive Firefox.
  // Not needed on Windows, where Firefox's job object kills us along with it.
  const parent = process.ppid;
  let parentMissing = 0;
  if (parent > 1 && process.platform !== "win32") {
    setInterval(() => {
      parentMissing = processGone(parent) || process.ppid !== parent ? parentMissing + 1 : 0;
      if (parentMissing >= 2) shutdown(`Firefox (pid ${parent}) is gone`);
    }, 5000).unref();
  }

  // When `install` replaces the binary we're running from, tell the add-on and
  // exit so it relaunches the new version straight away. Only a binary that
  // reports a different version counts: virus scanners, backup tools and
  // reinstalls of the same version touch the file too, and must not cost the
  // user their connection.
  if (isCompiled()) {
    const exe = process.execPath;
    const same = (x: fs.Stats | undefined, y: fs.Stats | undefined): boolean =>
      !!x && !!y && x.mtimeMs === y.mtimeMs && x.ino === y.ino && x.size === y.size;
    let known = fs.statSync(exe, { throwIfNoEntry: false });
    let timer: NodeJS.Timeout | undefined;
    let seen: fs.Stats | undefined;
    const check = (): void => {
      timer = undefined;
      if (exiting) return;
      const cur = fs.statSync(exe, { throwIfNoEntry: false });
      if (same(cur, known)) return;
      // Missing, empty or still being written: look again shortly.
      if (!cur || cur.size === 0 || !same(cur, seen)) {
        seen = cur;
        timer = setTimeout(check, 1000);
        return;
      }
      const v = binaryVersion(exe);
      if (!v) {
        timer = setTimeout(check, 5000); // couldn't run it yet (locked by a virus scan?)
        return;
      }
      known = cur;
      if (v === SERVER_VERSION) {
        console.error(`[webmcp] helper binary changed on disk but is still v${v}; staying up`);
        return;
      }
      console.error(`[webmcp] helper binary was replaced with v${v}; exiting so Firefox starts it`);
      const bye: HostExitMessage = { hostExit: { reason: "updated", version: v } };
      write(bye);
      shutdown(`updated to v${v}`);
    };
    fs.watchFile(exe, { interval: 2000, persistent: false }, () => {
      if (!timer) timer = setTimeout(check, 1000);
    });
  }

  console.error(
    `[webmcp] host ${SERVER_VERSION} started (pid ${process.pid}, parent ${parent}, ${process.platform}/${process.arch}, ${process.execPath})`,
  );
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
      return path.join(process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "webmcp-controller");
    case "mac":
      return path.join(home, "Library", "Application Support", "webmcp-controller");
    default:
      return path.join(process.env.XDG_DATA_HOME ?? path.join(home, ".local", "share"), "webmcp-controller");
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
  // Windows and macOS file systems ignore case by default; Linux's don't.
  const fold = (f: string): string => (platform() === "linux" ? path.resolve(f) : path.resolve(f).toLowerCase());
  if (fold(src) === fold(dest)) return;
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
    const old = `${dest}.old-${Date.now()}`;
    fs.renameSync(dest, old);
    try {
      fs.renameSync(tmp, dest);
    } catch (e2) {
      // Put the working helper back rather than leave none at all.
      try {
        fs.renameSync(old, dest);
      } catch {
        /* nothing more we can do; the error below says what failed */
      }
      fs.rmSync(tmp, { force: true });
      throw e2;
    }
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
    const dest = path.join(dir, win ? "webmcp-host.exe" : "webmcp-host");
    copySelf(dest);
    return dest;
  }
  // Dev install: `node dist/host.js install` → launcher script pointing at this checkout.
  const script = path.resolve(process.argv[1] ?? "");
  if (win) {
    const dest = path.join(dir, "webmcp-host.bat");
    // Paths can't contain quotes on Windows, but a literal % must be doubled in a .bat.
    const bat = (f: string): string => `"${f.replace(/%/g, "%%")}"`;
    fs.writeFileSync(dest, `@echo off\r\n${bat(process.execPath)} ${bat(script)} %*\r\n`);
    return dest;
  }
  const dest = path.join(dir, "webmcp-host.sh");
  const sh = (f: string): string => `'${f.replace(/'/g, "'\\''")}'`; // no $, ` or \ expansion inside '…'
  fs.writeFileSync(dest, `#!/bin/sh\nexec ${sh(process.execPath)} ${sh(script)} "$@"\n`);
  fs.chmodSync(dest, 0o755);
  return dest;
}

function hostManifest(exe: string, extensionId: string): string {
  return JSON.stringify(
    {
      name: NATIVE_HOST_NAME,
      description: "WebMCP Controller host: serves MCP to your local AI tools",
      path: exe,
      type: "stdio",
      allowed_extensions: [extensionId],
    },
    null,
    2,
  );
}

/** Unregister the pre-rename host so Firefox never launches a stale firefox-mcp helper. */
function removeLegacy(): string[] {
  const removed: string[] = [];
  if (platform() === "win") {
    const key = `HKCU\\Software\\Mozilla\\NativeMessagingHosts\\${LEGACY_HOST_NAME}`;
    if (spawnSync("reg", ["delete", key, "/f"], { encoding: "utf8" }).status === 0) removed.push(`registry ${key}`);
  } else {
    for (const d of manifestDirs()) {
      const file = path.join(d, `${LEGACY_HOST_NAME}.json`);
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
        removed.push(file);
      }
    }
  }
  return removed;
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

  const legacy = removeLegacy();

  console.error(`\nWebMCP Controller host ${SERVER_VERSION} installed.\n`);
  console.error(`  program:  ${exe}`);
  for (const w of written) console.error(`  manifest: ${w}`);
  for (const l of legacy) console.error(`  removed old firefox-mcp registration: ${l}`);
  console.error(`\nDone. The WebMCP Controller toolbar icon turns green within a few seconds`);
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
  console.error(`webmcp-host ${SERVER_VERSION} (${process.platform}/${process.arch}, ${isCompiled() ? "binary" : "node"})`);
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
  console.error(`webmcp-host ${SERVER_VERSION}

Usage:
  webmcp-host install [--extension-id ID]   register with Firefox (default when double-clicked)
  webmcp-host uninstall                     remove registration and files
  webmcp-host status                        show what's installed where
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
