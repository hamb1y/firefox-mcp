// Settings page regression tests: loads the REAL extension/options.html in a real
// Firefox (Playwright) against a fake background that keeps state like background.js.
//   npx playwright install firefox   (once)
//   node test/options.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { firefox } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PAGE = "file://" + path.join(root, "extension/options.html");

let failures = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${extra ? "  — " + extra : ""}`);
  if (!ok) failures += 1;
};

const READY = {
  version: "0.3.7", protocol: 1, compat: { state: "ok" }, platform: { os: "win", arch: "x86-64" }, hostMissing: false,
  connected: true, starting: false, listening: true, host: { version: "0.3.7", logFile: "C:\\Users\\me\\AppData\\Local\\webmcp-controller\\webmcp-host.log", url: "http://127.0.0.1:8901/mcp", extraUrls: [] },
  url: "http://127.0.0.1:8901/mcp", token: "a".repeat(64), port: 8901, bind: "127.0.0.1", allowWsl: false,
  confirmDestructive: true, showCursor: true, defaults: { port: 8901, bind: "127.0.0.1" }, lastError: "", commands: 3, connectedAt: Date.now() - 12 * 60000,
  events: [
    { at: Date.now() - 60000, text: "Helper stopped: <b>pipe</b>", level: "bad" },
    { at: Date.now() - 1000, text: "Listening on http://127.0.0.1:8901/mcp", level: "ok", count: 2 },
    { at: Date.now(), text: "Clicked “Sign in”", level: "info", site: "github.com" },
  ],
};

// Runs in the page: a fake runtime.sendMessage with the same validation as background.js.
function fakeBackground(initial) {
  const st = structuredClone(initial);
  window.__sent = [];
  window.__st = st;
  window.browser = { runtime: { sendMessage: async (m) => {
    window.__sent.push(m);
    const snap = () => structuredClone(st);
    if (m.type === "set-config") {
      if (m.port !== undefined) {
        const p = Number(m.port);
        if (!Number.isInteger(p) || p < 1024 || p > 65535) return { error: "Port must be a number between 1024 and 65535" };
        st.port = p;
        st.url = st.host.url = `http://${m.bind || st.bind}:${p}/mcp`;
      }
      if (m.bind !== undefined) {
        if (!/^\d+\.\d+\.\d+\.\d+$/.test(m.bind)) return { error: "Bind address must be an IP like 127.0.0.1 or 0.0.0.0" };
        st.bind = m.bind;
      }
      for (const k of ["allowWsl", "showCursor", "confirmDestructive"]) if (typeof m[k] === "boolean") st[k] = m[k];
      if (st.host) st.host.extraUrls = st.allowWsl ? [`http://172.17.16.1:${st.port}/mcp`] : [];
      return snap();
    }
    if (m.type === "regenerate-token") { st.token = "b".repeat(64); return snap(); }
    if (m.type === "set-paused") { st.paused = m.paused === true; return snap(); }
    return snap();
  } } };
}

const browser = await firefox.launch();
async function open(state, kind) {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(([s, k]) => {
    try { localStorage.clear(); if (k) localStorage.setItem("fxmcp.kind", k); } catch {}
  }, [state, kind]);
  await page.addInitScript(fakeBackground, state);
  await page.goto(PAGE);
  await page.waitForTimeout(300);
  page.errors = errors;
  return page;
}
const text = (page, sel) => page.locator(sel).textContent();
const visible = (page, sel) => page.locator(sel).isVisible();
const sent = (page) => page.evaluate(() => window.__sent.filter((m) => m.type !== "get-status"));

// ---- ready, on Windows ----
let page = await open(READY, "claude");
check("page loads without errors", page.errors.length === 0, page.errors.join("; "));
check("status says Ready", (await text(page, "#stateTxt")) === "Ready");
check("Retry is hidden when ready", !(await visible(page, "#retry")));
const cmd = await text(page, "#cfg");
check("Claude Code command replaces an existing entry", /^claude mcp remove --scope user firefox 2>\$null; claude mcp add --scope user /.test(cmd), cmd);
check("command carries the token", cmd.includes("Bearer " + "a".repeat(64)));
check("installed helper is tucked away", !(await visible(page, "#install")) && !(await visible(page, "#setupLaterBody pre")));
check("status facts filled in", (await text(page, "#factHelper")) === "v0.3.7" && (await text(page, "#factAddr")) === "127.0.0.1:8901" && /3 commands/.test(await text(page, "#factUp")));
check("WSL option offered on Windows", await visible(page, "#whereRow"));
check("WSL panel hidden for Windows-side AIs", !(await visible(page, "#wsl")));
const evs = await page.locator("#events li").allTextContents();
check("activity lists newest first, with site and count", evs.length === 3 && /Clicked “Sign in” · github\.com/.test(evs[0]) && /Listening.*×2/.test(evs[1]) && /Helper stopped/.test(evs[2]), JSON.stringify(evs));
check("activity text isn't parsed as HTML", (await page.locator("#events b").count()) === 0);
await page.locator("#helperDetails summary").click();
check("helper log path shown", /webmcp-host\.log/.test(await text(page, "#logLine")) && (await visible(page, "#logLine")));

// ---- pause ----
check("Pause offered while ready", (await visible(page, "#pause")) && (await text(page, "#pause")) === "Pause AI");
await page.locator("#pause").click();
await page.waitForTimeout(200);
check("Pause pauses", (await page.evaluate(() => window.__st.paused)) === true && (await text(page, "#stateTxt")) === "Paused" && (await text(page, "#pause")) === "Resume AI");
await page.locator("#pause").click();
await page.waitForTimeout(200);
check("Resume resumes", (await page.evaluate(() => window.__st.paused)) === false && (await text(page, "#stateTxt")) === "Ready");

// ---- Claude app ----
await page.locator("label:has(input[name=kind][value=claude-app])").click();
{
  const c = JSON.parse(await text(page, "#cfg")).mcpServers.firefox;
  check("Claude app goes through mcp-remote", c.command === "npx" && c.args.includes("mcp-remote") && c.args.includes("http://127.0.0.1:8901/mcp") &&
    c.args.includes("Authorization:${AUTH}") && c.env.AUTH === "Bearer " + "a".repeat(64), JSON.stringify(c));
  check("no WSL choice for the Claude app", !(await visible(page, "#whereRow")) && /claude_desktop_config\.json/.test(await text(page, "#kindHint")));
}
await page.locator("label:has(input[name=kind][value=claude])").click();

// ---- WSL ----
await page.locator("#inWsl").check();
await page.waitForTimeout(200);
check("WSL command looks up the Windows address", /\$\(ip route show default/.test(await text(page, "#cfg")) && /2>\/dev\/null/.test(await text(page, "#cfg")));
check("WSL switch shows next to the command", await visible(page, "#allowWsl"));
check("picking WSL turns WSL access on", (await sent(page)).some((m) => m.type === "set-config" && m.allowWsl === true) &&
  (await page.locator("#allowWsl").isChecked()));
check("choice is remembered", (await page.evaluate(() => localStorage.getItem("fxmcp.kind") + "/" + localStorage.getItem("fxmcp.where"))) === "claude/wsl");
check("WSL address shown once listening", /172\.17\.16\.1/.test(await text(page, "#wslState")), await text(page, "#wslState"));
await page.evaluate(() => { window.__st.host.wslAddress = "172.17.16.1"; });
await page.locator("label:has(input[name=kind][value=json])").click();
await page.waitForTimeout(1700);
let cfgTxt = await text(page, "#cfg");
check("any AI can be set up for WSL", (await visible(page, "#wsl")) && cfgTxt.includes("http://172.17.16.1:8901/mcp") && JSON.parse(cfgTxt).mcpServers.firefox.headers.Authorization === "Bearer " + "a".repeat(64), cfgTxt);
await page.locator("label:has(input[name=kind][value=codex])").click();
cfgTxt = await text(page, "#cfg");
check("Codex gets TOML", /^\[mcp_servers\.firefox\]/m.test(cfgTxt) && cfgTxt.includes("172.17.16.1"), cfgTxt);
await page.locator("#allowWsl").uncheck();
await page.waitForTimeout(200);
check("WSL off is flagged", /^Off/.test(await text(page, "#wslState")));
await page.locator("#inWsl").uncheck();
await page.locator("label:has(input[name=kind][value=gemini])").click();
cfgTxt = await text(page, "#cfg");
check("Gemini on Windows uses localhost", /^gemini mcp /.test(cfgTxt) && cfgTxt.includes("127.0.0.1:8901") && !(await visible(page, "#wsl")), cfgTxt);
await page.locator("label:has(input[name=kind][value=claude])").click();

// ---- toggles ----
await page.locator("#showCursor").uncheck();
await page.waitForTimeout(200);
check("cursor switch saves at once", (await page.evaluate(() => window.__st.showCursor)) === false);
await page.waitForTimeout(1700);
check("a poll doesn't flip a saved switch back", !(await page.locator("#showCursor").isChecked()));

// ---- port and bind ----
await page.locator("#tokenDetails summary").click();
check("Save is disabled until something changes", await page.locator("#save").isDisabled());
await page.locator("#port").fill("9100");
check("editing enables Save", await page.locator("#save").isEnabled());
await page.locator("#bind").click();
await page.waitForTimeout(1700);
check("polling keeps what you typed", (await page.locator("#port").inputValue()) === "9100");
await page.locator("#bind").press("Enter");
await page.waitForTimeout(200);
check("Enter saves the port", (await page.evaluate(() => window.__st.port)) === 9100);
check("config follows the new port", (await text(page, "#cfg")).includes(":9100/mcp"));
check("Save disables again after saving", await page.locator("#save").isDisabled());
await page.locator("#port").fill("80");
await page.locator("#save").click();
await page.waitForTimeout(200);
check("bad port is refused with a message", /Port must be/.test(await text(page, "#formErr")) &&
  (await page.locator("#port").getAttribute("aria-invalid")) === "true" && (await page.evaluate(() => window.__st.port)) === 9100);
await page.locator("#reset").click();
check("Reset fills in the defaults", (await page.locator("#port").inputValue()) === "8901" && (await page.locator("#formErr").textContent()) === "");

// ---- token ----
await page.locator("#regen").click();
await page.waitForTimeout(100);
check("first click on New token only asks", (await page.evaluate(() => window.__st.token)) === "a".repeat(64) &&
  /again/.test(await text(page, "#regen")));
await page.locator("#regen").click();
await page.waitForTimeout(200);
check("second click replaces the token", (await page.evaluate(() => window.__st.token)) === "b".repeat(64) &&
  (await page.locator("#token").inputValue()) === "b".repeat(64) && (await text(page, "#cfg")).includes("b".repeat(64)));
await page.locator("#reveal").click();
check("Show reveals the token", (await page.locator("#token").getAttribute("type")) === "text");
check("no errors after all that", page.errors.length === 0, page.errors.join("; "));
await page.close();

// ---- not on Windows ----
page = await open({ ...READY, platform: { os: "linux", arch: "x86-64" } }, "wsl");
check("no WSL option off Windows", !(await visible(page, "#whereRow")) && !(await visible(page, "#wsl")));
check("old WSL choice becomes Claude Code here", (await page.locator("input[value=claude]").isChecked()) && /2>\/dev\/null/.test(await text(page, "#cfg")) && (await text(page, "#cfg")).includes("127.0.0.1"));
await page.close();

// ---- helper missing ----
page = await open({ ...READY, platform: { os: "linux", arch: "x86-64" }, hostMissing: true, connected: false, listening: false, host: null, url: "" });
check("missing helper puts install steps first", (await visible(page, "#install")) && await page.locator("#install").evaluate((e) => e.classList.contains("attention") && getComputedStyle(e).order === "-1"));
check("no Pause while the helper is missing", !(await visible(page, "#pause")));
check("install command shown", /install\.sh \| sh/.test(await text(page, "#setupNow")) && /turns green/.test(await text(page, "#setupNow")));
check("Retry offered", await visible(page, "#retry"));
check("default harness is JSON", (await page.locator("input[value=json]").isChecked()) && /"mcpServers"/.test(await text(page, "#cfg")));
await page.waitForTimeout(3500);
check("keeps probing while missing", (await sent(page)).some((m) => m.type === "probe"));
check("no errors while missing", page.errors.length === 0, page.errors.join("; "));
await page.close();

// ---- background ignores the page (the old sender.tab guard did this to the settings tab) ----
page = await browser.newPage();
await page.addInitScript(() => { window.browser = { runtime: { sendMessage: async () => undefined } }; });
await page.goto(PAGE);
await page.waitForTimeout(300);
check("a silent background is reported, not left on Loading", /didn’t answer/.test(await text(page, "#stateTxt")), await text(page, "#stateTxt"));
await page.close();

await browser.close();
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
