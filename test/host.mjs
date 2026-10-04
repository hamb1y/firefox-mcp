// Native helper regression tests: talks to the REAL helper over native
// messaging framing as a fake add-on, and to its HTTP endpoint as a harness.
//   node test/host.mjs                       (helper = node mcp-server/dist/host.js)
//   node test/host.mjs path/to/webmcp-host   (test a compiled helper)
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hostCmd = process.argv.length > 2 ? process.argv.slice(2) : [process.execPath, path.join(root, "mcp-server/dist/host.js")];
const BASE = 19000 + Math.floor(Math.random() * 500);
const TOKEN = "t".repeat(32);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${extra ? "  — " + extra : ""}`);
  if (!ok) failures += 1;
};

// The helper logs into its install folder: keep that out of the real one.
const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), "webmcp-test-"));
const env = { ...process.env, XDG_DATA_HOME: dataHome };
const LOG = path.join(dataHome, "webmcp-controller", "webmcp-host.log");
const readLog = () => { try { return fs.readFileSync(LOG, "utf8"); } catch { return ""; } };

// ---- fake add-on ----
const child = spawn(hostCmd[0], [...hostCmd.slice(1), "/fake/webmcp_controller.json", "test@example"], { stdio: ["pipe", "pipe", "inherit"], env });
const fromHost = [];
let buf = Buffer.alloc(0);
child.stdout.on("data", (d) => {
  buf = Buffer.concat([buf, d]);
  while (buf.length >= 4) {
    const n = buf.readUInt32LE(0);
    if (buf.length < 4 + n) break;
    const m = JSON.parse(buf.subarray(4, 4 + n));
    buf = buf.subarray(4 + n);
    fromHost.push(m);
    onHostMessage(m);
  }
});
const post = (m) => { const b = Buffer.from(JSON.stringify(m)); const h = Buffer.alloc(4); h.writeUInt32LE(b.length); child.stdin.write(Buffer.concat([h, b])); };
// Commands: tabs.list answers at once; anything else is left hanging (like a long act.wait).
function onHostMessage(m) {
  if (m.method === "tabs.list") post({ id: m.id, ok: true, result: [{ id: 1, title: "t", url: "https://example.com/" }] });
}
const waitFor = async (pred, ms = 5000) => {
  for (let t = 0; t < ms; t += 25) { const m = fromHost.find(pred); if (m) return m; await sleep(25); }
  return undefined;
};
const hello = (protocol) => ({ hello: { extensionId: "test@example", version: "0", profile: "p", firefoxVersion: "150.0", capabilities: [], protocol } });
const config = (port) => ({ hostConfig: { port, bind: "127.0.0.1", token: TOKEN, confirmDestructive: true } });
const lastStatus = () => [...fromHost].reverse().find((m) => m.hostStatus)?.hostStatus;

// ---- raw HTTP (fetch won't let us forge Host) ----
function req(port, { method = "POST", path: p = "/mcp", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, method, path: p, headers: {
      "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer " + TOKEN, ...headers,
    } }, (res) => {
      let t = "";
      res.on("data", (d) => (t += d));
      res.on("end", () => {
        const data = t.match(/^data: (.*)$/m);
        let json;
        try { json = JSON.parse(data ? data[1] : t); } catch { json = undefined; }
        resolve({ status: res.statusCode, text: t, json });
      });
    });
    r.on("error", reject);
    if (body !== undefined) r.write(typeof body === "string" ? body : JSON.stringify(body));
    r.end();
  });
}
const call = (port, name, args = {}, id = 1) =>
  req(port, { body: { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } } });
const resultText = (r) => r.json?.result?.content?.[0]?.text ?? r.json?.error?.message ?? r.text;
const portOpen = (port) => new Promise((resolve) => {
  const s = net.connect({ host: "127.0.0.1", port }, () => { s.destroy(); resolve(true); });
  s.on("error", () => resolve(false));
});

post(hello(1));

// Rapid reconfiguration: only the last settings should end up listening.
const ports = [BASE, BASE + 1, BASE + 2, BASE + 3];
for (const p of ports) post(config(p));
let st;
for (let t = 0; t < 5000; t += 50) { st = lastStatus(); if (st?.listening && st.port === ports[3]) break; await sleep(50); }
await sleep(300);
st = lastStatus();
check("rapid reconfiguration settles on the last port", st?.listening && st.port === ports[3], JSON.stringify(st && { port: st.port, listening: st.listening }));
const stale = await Promise.all(ports.slice(0, 3).map(portOpen));
check("earlier ports are closed", stale.every((x) => !x), stale.join(","));
const PORT = ports[3];

check("status says when the helper started and where it logs", st.startedAt > Date.now() - 60000 && st.logFile === LOG, JSON.stringify({ startedAt: st.startedAt, logFile: st.logFile }));
check("helper writes a log", /host .* started \(pid/.test(readLog()), readLog().slice(0, 200));

// Clients that open a GET stream must be told no: an idle stream that later broke made them give up on the server.
let r = await req(PORT, { method: "GET" });
check("GET /mcp -> 405, POST only", r.status === 405 && /POST/.test(r.text), `${r.status} ${r.text.slice(0, 80)}`);
r = await req(PORT, { method: "DELETE" });
check("DELETE /mcp -> 405", r.status === 405, String(r.status));
r = await req(PORT, { method: "GET", headers: { authorization: "Bearer nope" } });
check("GET /mcp still needs the token", r.status === 401, String(r.status));

r = await call(PORT, "tabs_list");
check("tabs_list works", r.status === 200 && /example\.com/.test(resultText(r)), resultText(r));

// DNS rebinding / cross-site guards.
r = await req(PORT, { headers: { host: "evil.example:" + PORT }, body: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
check("foreign Host header -> 403", r.status === 403, String(r.status));
r = await req(PORT, { headers: { origin: "https://evil.example" }, body: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
check("foreign Origin -> 403", r.status === 403, String(r.status));
r = await req(PORT, { headers: { host: "localhost:" + PORT, origin: "http://localhost:3000" }, body: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
check("loopback Host/Origin allowed", r.status === 200, String(r.status));
r = await req(PORT, { method: "GET", path: "/health", headers: { host: "evil.example" } });
check("/health is guarded too", r.status === 403, String(r.status));

// Malformed bodies.
r = await req(PORT, { headers: { authorization: "Bearer nope" }, body: "{not json" });
check("bad token + malformed JSON -> 401 (auth first)", r.status === 401, String(r.status));
r = await req(PORT, { body: "{not json" });
check("malformed JSON -> 400 parse error", r.status === 400 && r.json?.error?.code === -32700, `${r.status} ${r.text.slice(0, 80)}`);
r = await req(PORT, { body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", pad: "x".repeat(3 * 1024 * 1024) }) });
check("body over the HTTP limit -> 413", r.status === 413, String(r.status));

// Larger than one native message: refused before it reaches Firefox.
r = await call(PORT, "act_type", { ref: 1, text: "x".repeat(1100 * 1024) });
check("oversized command -> PAYLOAD_TOO_LARGE", r.json?.result?.isError && /PAYLOAD_TOO_LARGE/.test(resultText(r)), resultText(r).slice(0, 120));

// Cancellation by dropping the HTTP request.
fromHost.length = 0;
const ac = new AbortController();
const pending = fetch(`http://127.0.0.1:${PORT}/mcp`, {
  method: "POST", signal: ac.signal,
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer " + TOKEN },
  body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "act_wait", arguments: { text: "never", timeoutMs: 60000 } } }),
}).catch(() => "aborted");
let cmd = await waitFor((m) => m.method === "act.wait");
ac.abort();
await pending;
let cancel = cmd && (await waitFor((m) => m.cancel === cmd.id));
check("closing the request cancels the command in Firefox", !!cancel, cmd ? "" : "act.wait never sent");

// Cancellation by notifications/cancelled.
fromHost.length = 0;
const slow = call(PORT, "act_wait", { text: "never", timeoutMs: 60000 }, 77);
cmd = await waitFor((m) => m.method === "act.wait");
await req(PORT, { body: { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 77, reason: "test" } } });
cancel = cmd && (await waitFor((m) => m.cancel === cmd.id));
check("notifications/cancelled cancels the command in Firefox", !!cancel);
const slowRes = await Promise.race([slow, sleep(3000).then(() => null)]);
check("cancelled request finishes promptly", slowRes !== null);

// Protocol mismatch: the add-on reconnects speaking a newer protocol.
post(hello(99));
await sleep(200);
r = await call(PORT, "tabs_list");
check("protocol mismatch refuses commands", /PROTOCOL_MISMATCH/.test(resultText(r)) && /update the helper/.test(resultText(r)), resultText(r));
post(hello(1));
await sleep(200);
r = await call(PORT, "tabs_list");
check("matching protocol works again", /example\.com/.test(resultText(r)), resultText(r));

// A port that's busy (another Firefox profile, or the old helper still exiting) is retried until it frees up.
const BUSY = BASE + 10;
const blocker = net.createServer().listen(BUSY, "127.0.0.1");
await new Promise((res) => blocker.once("listening", res));
post(config(BUSY));
for (let t = 0; t < 3000; t += 50) { st = lastStatus(); if (st?.port === BUSY && st.error) break; await sleep(50); }
check("busy port is reported", st?.port === BUSY && !st.listening && /^Port /.test(st.error ?? ""), JSON.stringify(st && { listening: st.listening, error: st.error }));
await new Promise((res) => blocker.close(res));
for (let t = 0; t < 8000; t += 100) { st = lastStatus(); if (st?.listening) break; await sleep(100); }
check("helper takes the port once it's free", st?.listening && st.port === BUSY && !st.error, JSON.stringify(st && { listening: st.listening, error: st.error }));
r = await call(BUSY, "tabs_list");
check("and serves on it", /example\.com/.test(resultText(r)), resultText(r));

// Firefox closing the pipe ends the helper and frees the port.
const exited = new Promise((res) => child.once("exit", () => res(true)));
child.stdin.end();
const gone = await Promise.race([exited, sleep(3000).then(() => false)]);
check("helper exits when Firefox closes the pipe", gone);
check("and frees the port", !(await portOpen(BUSY)));
check("exit reason is logged", /exiting: Firefox closed the connection/.test(readLog()), readLog().split("\n").slice(-3).join(" | "));
if (!gone) child.kill();

// A parent that dies without closing the pipe (the pipe's other end lives on in a grandchild here).
if (process.platform !== "win32" && process.argv.length <= 2) {
  const q = (x) => `'${x.replace(/'/g, "'\\''")}'`;
  const orphanLog = path.join(dataHome, "orphan");
  const sh = spawn("sh", ["-c", `sleep 60 | ${hostCmd.map(q).join(" ")} /fake/m.json test@example & sleep 0.5`], {
    stdio: "ignore", env: { ...env, XDG_DATA_HOME: orphanLog },
  });
  await new Promise((res) => sh.once("exit", res));
  const olog = () => { try { return fs.readFileSync(path.join(orphanLog, "webmcp-controller", "webmcp-host.log"), "utf8"); } catch { return ""; } };
  let ok = false;
  for (let t = 0; t < 16000 && !ok; t += 250) { ok = /exiting: Firefox \(pid \d+\) is gone/.test(olog()); if (!ok) await sleep(250); }
  check("helper exits when its parent dies", ok, olog().split("\n").slice(-3).join(" | "));
}

fs.rmSync(dataHome, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
