// End-to-end: runs the REAL extension/background.js in a vm with a mocked
// `browser`, whose connectNative() spawns the REAL native helper; then drives
// MCP over HTTP like a harness would.
//   node test/e2e.mjs                       (helper = node mcp-server/dist/host.js)
//   node test/e2e.mjs path/to/webmcp-host   (test a compiled helper)
//   MISSING=1 node test/e2e.mjs             (helper-not-installed flow)
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hostCmd = process.argv.length > 2 ? process.argv.slice(2) : [process.execPath, path.join(root, "mcp-server/dist/host.js")];
const manifest = JSON.parse(fs.readFileSync(path.join(root, "extension/manifest.json"), "utf8"));
const EXT_ID = manifest.browser_specific_settings.gecko.id;
const PORT = Number(process.env.PORT || 18900 + Math.floor(Math.random() * 60));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = () => { const l = []; return { addListener: (f) => l.push(f), fire: (...a) => l.forEach((f) => f(...a)), l }; };
let failures = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${extra ? "  — " + extra : ""}`);
  if (!ok) failures += 1;
};

let store = { mcpPort: PORT }, missing = process.env.MISSING === "1", child;
function connectNative(name) {
  const onMessage = ev(), onDisconnect = ev();
  const port = { onMessage, onDisconnect, error: null, postMessage() {}, disconnect() { child?.kill(); } };
  if (missing) { setTimeout(() => { port.error = { message: "No such native application " + name }; onDisconnect.fire(port); }, 10); return port; }
  child = spawn(hostCmd[0], [...hostCmd.slice(1), "/fake/" + name + ".json", EXT_ID], { stdio: ["pipe", "pipe", "inherit"] });
  let buf = Buffer.alloc(0);
  child.stdout.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 4) {
      const n = buf.readUInt32LE(0);
      if (buf.length < 4 + n) break;
      const m = JSON.parse(buf.subarray(4, 4 + n));
      buf = buf.subarray(4 + n);
      onMessage.fire(m);
    }
  });
  child.on("exit", () => onDisconnect.fire(port));
  port.postMessage = (m) => { const b = Buffer.from(JSON.stringify(m)); const h = Buffer.alloc(4); h.writeUInt32LE(b.length); child.stdin.write(Buffer.concat([h, b])); };
  return port;
}

// Fake content script: records what the background sends to the page.
const sent = [];
const shotLog = [];
const TAB = { id: 7, windowId: 1, index: 0, url: "https://example.com/", title: "Example", active: true, status: "complete", cookieStoreId: "firefox-container-2" };
const cookieQueries = [];
const COOKIES = [
  { name: "plain", value: "1", domain: "example.com" },
  { name: "chips-here", value: "2", domain: "cdn.test", partitionKey: { topLevelSite: "https://example.com" } },
  { name: "chips-elsewhere", value: "3", domain: "cdn.test", partitionKey: { topLevelSite: "https://other.test" } },
];
const extraTabs = [];
const onMsg = ev();
let pageGone = null; // (msg) => true makes the page vanish under that message, like a navigation
const browser = {
  runtime: {
    id: EXT_ID, getManifest: () => manifest, connectNative, onMessage: onMsg, getURL: (p = "") => "moz-extension://test-uuid/" + p,
    getBrowserInfo: async () => ({ version: "150.0" }), getPlatformInfo: async () => ({ os: "linux", arch: "x86-64" }), openOptionsPage() {},
  },
  storage: { local: { get: async (k) => Object.fromEntries(k.filter((x) => x in store).map((x) => [x, store[x]])), set: async (o) => Object.assign(store, o) } },
  tabs: {
    query: async () => [TAB, ...extraTabs], get: async () => TAB,
    update: async (id, props) => Object.assign(TAB, props),
    sendMessage: async (tabId, msg) => {
      sent.push(JSON.parse(JSON.stringify(msg)));
      if (pageGone?.(msg)) throw new Error("Message manager disconnected");
      if (msg.kind === "cursor") shotLog.push(msg.op);
      if (msg.kind === "act-wait") return new Promise(() => {}); // until cancelled
      return { __fxmcp: true, ok: true, result: msg.kind === "cursor" ? { ok: true, shown: true } : { clicked: true } };
    },
    captureVisibleTab: async () => { shotLog.push("capture"); return "data:image/png;base64,AAAA"; },
    onUpdated: ev(), onRemoved: ev(), onActivated: ev(),
  },
  cookies: { getAll: async (q) => { cookieQueries.push(JSON.parse(JSON.stringify(q))); return COOKIES; } },
  downloads: { onChanged: ev() }, browserAction: { setBadgeText() {}, setBadgeBackgroundColor() {}, setTitle() {} },
};
const ctx = vm.createContext({ browser, console: { log() {} }, setTimeout, clearTimeout, setInterval, crypto: globalThis.crypto, Promise, Uint8Array, URL, AbortController, AbortSignal });
vm.runInContext(fs.readFileSync(path.join(root, "extension/background.js"), "utf8"), ctx);
// The settings page opens in a tab, so its messages carry sender.tab like a content script's do.
const SETTINGS = { id: EXT_ID, url: "moz-extension://test-uuid/options.html", tab: { id: 9 } };
const askAs = (sender, m) => Promise.all(onMsg.l.map((f) => f(m, sender))).then((r) => r.find((x) => x !== undefined));
const ask = (m) => askAs(SETTINGS, m);
const waitFor = async (pred, ms = 5000) => {
  let st;
  for (let t = 0; t < ms; t += 100) { st = await ask({ type: "get-status" }); if (pred(st)) return st; await sleep(100); }
  return st;
};

let st = await waitFor((s) => s.listening || s.hostMissing);
if (missing) {
  check("helper missing is reported", st.hostMissing === true && !st.listening);
  missing = false; // the user ran the install command
  await ask({ type: "probe" });
  st = await waitFor((s) => s.listening);
  check("probe picks up a freshly installed helper", st.listening, st.url);
  child?.kill();
  process.exit(failures ? 1 : 0);
}

check("helper starts and listens", st.listening, st.url || st.lastError);
check("versions match", st.compat.state === "ok", JSON.stringify(st.compat));
check("helper reports protocol", st.host.protocol === 1);
check("cursor on by default", st.showCursor === true);

const mcp = async (method, params, token = st.token, url = st.url) => {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer " + token },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const t = await r.text();
  const data = t.match(/^data: (.*)$/m);
  return { status: r.status, body: data ? JSON.parse(data[1]) : t };
};
const tool = (name, args = {}) => mcp("tools/call", { name, arguments: args });
const text = (r) => r.body?.result?.content?.[0]?.text ?? JSON.stringify(r.body);

const init = await mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });
check("server instructions mention the cursor", /cursor/i.test(init.body?.result?.instructions || ""));
const list = await mcp("tools/list", {});
const tools = list.body.result.tools;
const click = tools.find((t) => t.name === "act_click");
check("page tools take an optional thought", !!click?.inputSchema?.properties?.thought && !click.inputSchema.required?.includes("thought"));
check("cursor_note tool exists", tools.some((t) => t.name === "cursor_note"));
check("meta tools have no thought", !tools.find((t) => t.name === "extension_status").inputSchema?.properties?.thought);

let r = await tool("tabs_list");
check("tabs_list", r.status === 200 && /example\.com/.test(text(r)));
extraTabs.push({ id: 8, windowId: 1, index: 1, url: "https://asleep.test/", title: "Asleep", discarded: true, status: "complete" });
r = await tool("tabs_list", { includeDiscarded: false });
check("tabs_list includeDiscarded:false leaves discarded tabs out", !/asleep/.test(text(r)) && /example\.com/.test(text(r)), text(r));
r = await tool("tabs_list");
check("tabs_list includes discarded tabs by default", /asleep/.test(text(r)), text(r));
extraTabs.length = 0;
r = await tool("tabs_query", { urlPattern: "(a+)+$" });
check("tabs_query refuses a catastrophic regex", /INVALID_PARAMS/.test(text(r)) && /nested/.test(text(r)), text(r));
r = await tool("tabs_query", { urlPattern: "^https://(?:www\\.)?example\\.com/" });
check("tabs_query still takes ordinary regexes", /example\.com/.test(text(r)), text(r));
let t0 = Date.now();
r = await tool("tab_navigate", { url: "https://example.com/#pricing", timeoutMs: 5000 });
check("a #fragment navigation doesn't wait for a load that never comes", /"loadComplete": true/.test(text(r)) && Date.now() - t0 < 2000, `${Date.now() - t0}ms ${text(r)}`);
TAB.url = "https://example.com/";

sent.length = 0;
await tool("act_click", { ref: 3, thought: "Opening the pricing page" });
let m = sent.find((x) => x.kind === "act-click");
check("thought reaches the page with the action", m?.cursor?.note === "Opening the pricing page", JSON.stringify(m));
check("thought is not passed as a tool arg", m && !("thought" in m));

sent.length = 0;
await tool("act_click", { ref: 3 });
m = sent.find((x) => x.kind === "act-click");
check("cursor shown even without a thought", m?.cursor && m.cursor.note === "");

sent.length = 0;
await tool("tabs_list", { thought: "Checking what's open" });
await sleep(100);
check("thought on a non-page tool is shown on the active tab", sent.some((x) => x.kind === "cursor" && x.op === "say" && x.note === "Checking what's open"));

sent.length = 0;
r = await tool("cursor_note", { note: "Thinking about which plan is cheaper" });
check("cursor_note", sent.some((x) => x.kind === "cursor" && x.op === "say" && /cheaper/.test(x.note)), text(r));

shotLog.length = 0;
await tool("screenshot", {});
await sleep(50);
check("cursor hidden during screenshot", shotLog.join(",") === "conceal,capture,reveal", shotLog.join(","));

sent.length = 0;
st = await ask({ type: "set-config", showCursor: false });
check("cursor toggle saved", st.showCursor === false && store.mcpShowCursor === false);
await sleep(50);
check("turning it off hides it everywhere", sent.some((x) => x.kind === "cursor" && x.op === "hide"));
sent.length = 0;
await tool("act_click", { ref: 3, thought: "x" });
m = sent.find((x) => x.kind === "act-click");
check("no cursor when turned off", m && !m.cursor);
await ask({ type: "set-config", showCursor: true });

r = await tool("cookies_for_tab", {});
check("cookies come from the tab's container", cookieQueries.at(-1)?.storeId === "firefox-container-2", JSON.stringify(cookieQueries.at(-1)));
check("cookies include ones partitioned under this site only", /chips-here/.test(text(r)) && /plain/.test(text(r)) && !/chips-elsewhere/.test(text(r)), text(r));

pageGone = (x) => x.kind === "act-click";
r = await tool("act_click", { ref: 3 });
check("click that navigates the page reports pageChanged", !r.body?.result?.isError && /pageChanged|navigated/i.test(text(r)), text(r));
let gone = 0;
pageGone = (x) => x.kind === "page-text" && gone++ === 0;
r = await tool("page_text", {});
check("read during a reload is retried", !r.body?.result?.isError && gone === 2, text(r));
pageGone = (x) => x.kind === "act-wait";
r = await tool("act_wait", { text: "never" });
check("wait interrupted by navigation says so", r.body?.result?.isError && /NAVIGATED|navigated/.test(text(r)), text(r));
pageGone = null;

sent.length = 0;
const ac = new AbortController();
const waiting = fetch(st.url, {
  method: "POST", signal: ac.signal,
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer " + st.token },
  body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "act_wait", arguments: { text: "never" } } }),
}).catch(() => "aborted");
for (let t = 0; t < 3000 && !sent.some((x) => x.kind === "act-wait"); t += 50) await sleep(50);
ac.abort();
await waiting;
const opId = sent.find((x) => x.kind === "act-wait")?.opId;
for (let t = 0; t < 3000 && !sent.some((x) => x.kind === "cancel"); t += 50) await sleep(50);
check("cancelling act_wait stops the wait in the page", !!opId && sent.some((x) => x.kind === "cancel" && x.opId === opId), JSON.stringify(sent.map((x) => x.kind)));

const old = st.token;
st = await ask({ type: "regenerate-token" });
check("old token rejected after regenerate", (await mcp("tools/call", { name: "tabs_list", arguments: {} }, old)).status === 401);
r = await mcp("tools/call", { name: "tabs_list", arguments: {} });
check("new token accepted", r.status === 200);

const port2 = PORT + 61;
await ask({ type: "set-config", port: port2, bind: "127.0.0.1" });
st = await waitFor((s) => s.listening && s.url.includes(":" + port2));
check("port change", st.url.includes(":" + port2) && (await tool("tabs_list")).status === 200, st.url);
check("bad port rejected", !!(await ask({ type: "set-config", port: 80 })).error);
check("settings tab is answered", !!(await ask({ type: "get-status" }))?.token);
check("popup is answered", !!(await askAs({ id: EXT_ID, url: "moz-extension://test-uuid/popup.html" }, { type: "get-status" }))?.token);
check("content script is ignored", (await askAs({ id: EXT_ID, url: "https://example.com/", tab: { id: 1 } }, { type: "regenerate-token" })) === undefined);
check("other extension is ignored", (await askAs({ id: "evil@x", url: "moz-extension://other/options.html" }, { type: "get-status" })) === undefined);
check("sender without a URL is ignored", (await askAs({ id: EXT_ID }, { type: "get-status" })) === undefined);

const quick = [PORT + 62, PORT + 63, PORT + 64];
await Promise.all(quick.map((p) => ask({ type: "set-config", port: p })));
st = await waitFor((s) => s.listening && s.url.includes(":" + quick[2]));
check("rapid port changes end on the last one", st.url.includes(":" + quick[2]) && (await tool("tabs_list")).status === 200, st.url);

await ask({ type: "reconnect" });
st = await waitFor((s) => s.listening && s.connectedAt);
check("reconnect", st.listening && (await tool("tabs_list")).status === 200);

child?.kill();
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
