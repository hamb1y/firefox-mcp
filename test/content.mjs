// Content-script regression tests: loads the REAL extension/content/ax.js into
// pages in a real Firefox (Playwright) and drives it with the same messages
// background.js sends.
//   npx playwright install firefox   (once)
//   node test/content.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { firefox } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AX = fs.readFileSync(path.join(root, "extension/content/ax.js"), "utf8");
// Stand-in for the WebExtension runtime: window.__send(msg) acts like tabs.sendMessage.
const SHIM = `window.browser = { runtime: { onMessage: { addListener(f) { window.__send = (m) => f(m, {}, undefined); } } } };`;

let failures = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${extra ? "  — " + extra : ""}`);
  if (!ok) failures += 1;
};

const browser = await firefox.launch();
let page;

/** A fresh document (new window, so nothing carries over) with ax.js loaded. */
async function load(html) {
  await page?.close();
  page = await browser.newPage();
  await page.setContent(`<!doctype html><html><body>${html}</body></html>`);
  await page.addScriptTag({ content: SHIM });
  await page.addScriptTag({ content: AX });
}
const send = (msg) => page.evaluate((m) => window.__send(m), msg);
/** Run a command; returns the result, or { error: {code, message} }. */
async function run(msg) {
  const env = await send(msg);
  return env.ok ? env.result : { error: env.error };
}
const snap = (extra = {}) => run({ kind: "ax-snapshot", ...extra });
const refOf = (s, role, name) => s.nodes.find((n) => n.role === role && (name === undefined || n.name === name))?.ref;
const ev = (js) => page.evaluate(js);

// ---- refs and generations ----
await load(`<button onclick="window.hit='A'">A</button>`);
let s1 = await snap();
const refA = refOf(s1, "button", "A");
await page.evaluate(() => { document.body.innerHTML = `<button onclick="window.hit='B'">B</button>`; });
let s2 = await snap();
const refB = refOf(s2, "button", "B");
check("refs are never reused within a page", refA !== refB, `${refA} ${refB}`);
let r = await run({ kind: "act-click", ref: refA });
check("old ref to a removed element is stale, not another element", r.error?.code === "REF_STALE" && (await ev("window.hit")) === undefined, JSON.stringify(r));
r = await run({ kind: "act-click", ref: refB, generation: "g99-zzz" });
check("unknown snapshot generation is rejected", r.error?.code === "REF_STALE", JSON.stringify(r));
r = await run({ kind: "act-click", ref: refB, generation: s2.generation });
check("ref with its generation works", r.clicked && (await ev("window.hit")) === "B", JSON.stringify(r));
await load(`<button>A</button>`);
r = await run({ kind: "act-click", ref: refB });
check("ref from a previous page load is unknown", r.error?.code === "REF_NOT_FOUND", JSON.stringify(r));

// ---- submission ----
await load(`<form id=f onsubmit="event.preventDefault(); window.n=(window.n||0)+1"><input id=q><button>Go</button></form>`);
let s = await snap();
r = await run({ kind: "act-type", ref: refOf(s, "textbox"), text: "hello", submit: true });
await page.waitForTimeout(500);
check("one act_type submit = one submission", (await ev("window.n")) === 1, `submits=${await ev("window.n")} ${JSON.stringify(r)}`);

await load(`<div id=composer><textarea id=t></textarea></div><div><button onclick="window.sent=1">Send</button></div>`);
s = await snap();
r = await run({ kind: "act-type", ref: refOf(s, "textbox"), text: "hi", submit: true });
check("submit never clicks an unrelated Send button", !(await ev("window.sent")) && r.submitted === false, JSON.stringify(r));

await load(`<div id=composer><textarea id=t></textarea><button onclick="window.sent=1">Send</button></div>`);
s = await snap();
r = await run({ kind: "act-type", ref: refOf(s, "textbox"), text: "hi", submit: true });
check("submit uses the composer's own Send button", (await ev("window.sent")) === 1 && r.submitted === "button", JSON.stringify(r));

// ---- select ----
await load(`<select id=s><option value="US">United States</option><option value="us">Lowercase us</option><option value="fr">France</option></select>`);
s = await snap();
r = await run({ kind: "act-select", ref: refOf(s, "combobox"), values: ["us"] });
check("select matches the exact value first", (await ev("document.getElementById('s').value")) === "us", JSON.stringify(r));
r = await run({ kind: "act-select", ref: refOf(s, "combobox"), values: ["France"] });
check("select falls back to the label", (await ev("document.getElementById('s').value")) === "fr", JSON.stringify(r));
r = await run({ kind: "act-select", ref: refOf(s, "combobox"), values: ["Germany"] });
check("select with no match fails", r.error?.code === "NO_MATCH", JSON.stringify(r));

// ---- checkbox state ----
await load(`<label><input type=checkbox id=c> Agree</label><input id=name>`);
s = await snap();
const cb = refOf(s, "checkbox");
await run({ kind: "act-fillForm", fields: [{ ref: cb, value: "false" }] });
check("fill false leaves an unchecked box unchecked", (await ev("document.getElementById('c').checked")) === false);
await run({ kind: "act-fillForm", fields: [{ ref: cb, value: "true" }] });
await run({ kind: "act-fillForm", fields: [{ ref: cb, value: "true" }] });
check("fill true twice stays checked", (await ev("document.getElementById('c').checked")) === true);
r = await run({ kind: "act-fillForm", fields: [{ ref: cb, value: "maybe" }] });
check("bad checkbox value rejected", r.error?.code === "INVALID_PARAMS", JSON.stringify(r));

// ---- fill_form validation is all-or-nothing ----
r = await run({ kind: "act-fillForm", fields: [{ ref: refOf(s, "textbox"), value: "Ann" }, { selector: "#nope", value: "x" }] });
check("fill_form with a bad field changes nothing", r.error && (await ev("document.getElementById('name').value")) === "", JSON.stringify(r));
r = await run({ kind: "act-fillForm", fields: [{ value: "x" }] });
check("fill_form field without a target is an error", r.error?.code === "INVALID_PARAMS", JSON.stringify(r));

// ---- keyboard ----
await load(`<input id=a><input id=b>`);
await page.evaluate(() => {
  window.keys = [];
  document.addEventListener("keydown", (e) => window.keys.push({ key: e.key, ctrl: e.ctrlKey }));
  document.getElementById("a").focus();
});
await run({ kind: "act-key", key: "a", modifiers: ["Ctrl"] });
check("Ctrl modifier is sent", (await ev("window.keys.at(-1)?.ctrl")) === true, JSON.stringify(await ev("window.keys")));
r = await run({ kind: "act-key", key: "Tab" });
check("Tab moves focus", (await ev("document.activeElement.id")) === "b", JSON.stringify(r));

// ---- scrolling ----
await load(`<style>.box{height:200px;overflow:auto} .tall{height:2000px}</style>
  <div class=box id=hidden style="visibility:hidden"><div class=tall></div></div>
  <div class=box id=shown><div class=tall></div></div>`);
r = await run({ kind: "act-scroll", direction: "down", pixels: 100 });
const pos = await ev("[document.getElementById('hidden').scrollTop, document.getElementById('shown').scrollTop]");
check("scroll skips hidden containers", pos[0] === 0 && pos[1] > 0, JSON.stringify({ pos, r }));
check("scroll doesn't claim the end early", r.scrolled === true && r.atEnd === false, JSON.stringify(r));

// ---- shadow DOM ----
await load(`<my-field></my-field>`);
await page.evaluate(() => {
  const host = document.querySelector("my-field");
  host.attachShadow({ mode: "open" }).innerHTML = `<input aria-label="Inner">`;
  document.addEventListener("input", (e) => (window.got = e.composedPath()[0].value));
});
s = await snap();
r = await run({ kind: "act-type", ref: refOf(s, "textbox", "Inner"), text: "deep" });
check("input event from a shadow-root field reaches the document", (await ev("window.got")) === "deep", JSON.stringify(r));

// ---- accessibility visibility ----
await load(`<div aria-hidden="true"><button>Hidden</button></div><div style="display:contents"><button style="display:contents">Contents</button></div>`);
s = await snap();
check("aria-hidden subtree is left out", !refOf(s, "button", "Hidden"), JSON.stringify(s.nodes));
check("display:contents button is kept", !!refOf(s, "button", "Contents"), JSON.stringify(s.nodes));

// ---- actions that can't work say so ----
await load(`<button disabled onclick="window.hit=1">Off</button><button id=btn>Label</button><input readonly id=ro value=x>`);
s = await snap();
r = await run({ kind: "act-click", ref: refOf(s, "button", "Off") });
check("clicking a disabled button fails", r.error?.code === "ELEMENT_DISABLED" && !(await ev("window.hit")), JSON.stringify(r));
r = await run({ kind: "act-type", ref: refOf(s, "button", "Label"), text: "x" });
check("typing into a button fails", r.error?.code === "NOT_EDITABLE" && (await ev("document.getElementById('btn').textContent")) === "Label", JSON.stringify(r));
r = await run({ kind: "act-type", selector: "#ro", text: "y" });
check("typing into a read-only input fails", r.error?.code === "NOT_EDITABLE" && (await ev("document.getElementById('ro').value")) === "x", JSON.stringify(r));

// ---- snapshot budget ----
await load("");
await page.evaluate(() => { document.body.innerHTML = Array.from({ length: 10000 }, (_, i) => `<button>b${i}</button>`).join(""); });
const t0 = Date.now();
s = await snap({ maxChars: 30 });
const ms = Date.now() - t0;
check("small snapshot budget stops early", s.truncated && s.nodes.length < 10, `${s.nodes.length} nodes, ${ms} ms`);

// ---- cancellation ----
await load(`<p>nothing here</p>`);
const waiting = run({ kind: "act-wait", text: "never", opId: "op1", timeoutMs: 10000 });
await page.waitForTimeout(200);
await run({ kind: "cancel", opId: "op1" });
r = await Promise.race([waiting, page.waitForTimeout(3000).then(() => "still waiting")]);
check("cancel stops act_wait in the page", r?.error?.code === "CANCELLED", JSON.stringify(r));

await load(`<input id=q><button onclick="window.hit=1">Go</button>`);
await run({ kind: "cancel", opId: "op2" });
r = await run({ kind: "act-type", selector: "#q", text: "late", opId: "op2" });
check("a command cancelled before it starts does nothing", r.error?.code === "CANCELLED" && (await ev("document.getElementById('q').value")) === "", JSON.stringify(r));

// ---- explicit and ambiguous submit ----
await load(`<div><textarea id=t></textarea><button onclick="window.a=1">Send</button><button onclick="window.b=1">Send now</button></div>`);
s = await snap();
r = await run({ kind: "act-type", selector: "#t", text: "hi", submit: true });
check("two Send-like buttons: submit asks instead of guessing", r.submitted === false && /submitRef/.test(r.note) && !(await ev("window.a || window.b")), JSON.stringify(r));
r = await run({ kind: "act-type", selector: "#t", text: "hi", submitRef: refOf(s, "button", "Send now"), generation: s.generation });
check("submitRef clicks exactly that button", r.submitted === "button" && (await ev("window.b")) === 1 && !(await ev("window.a")), JSON.stringify(r));
r = await run({ kind: "act-type", selector: "#t", text: "x", submitSelector: "#nope" });
check("a bad submit target fails before typing", !!r.error && (await ev("document.getElementById('t').value")) === "hi", JSON.stringify(r));

await load(`<form onsubmit="event.preventDefault(); window.n=1"><input id=e type=email required><button>Go</button></form>`);
r = await run({ kind: "act-type", selector: "#e", text: "not-an-email", submit: true });
check("an invalid form isn't submitted, and says why", r.submitted === false && /invalid/.test(r.note) && !(await ev("window.n")), JSON.stringify(r));

// ---- unreachable elements ----
await load(`<div inert><button onclick="window.hit=1">Behind</button><input id=i></div>`);
r = await run({ kind: "act-click", selector: "button" });
check("clicking an inert button fails", r.error?.code === "NOT_INTERACTABLE" && !(await ev("window.hit")), JSON.stringify(r));
r = await run({ kind: "act-type", selector: "#i", text: "x" });
check("typing into an inert field fails", r.error?.code === "NOT_INTERACTABLE", JSON.stringify(r));

await load(`<button id=out onclick="window.hit=1">Outside</button><dialog id=d><button>Inside</button></dialog>`);
await ev("document.getElementById('d').showModal()");
r = await run({ kind: "act-click", selector: "#out" });
check("clicking behind a modal dialog fails", r.error?.code === "NOT_INTERACTABLE" && !(await ev("window.hit")), JSON.stringify(r));

await load(`<select id=s><optgroup label=Old disabled><option value=a>Alpha</option></optgroup><option value=b>Beta</option></select>`);
r = await run({ kind: "act-select", selector: "#s", values: ["a"] });
check("an option in a disabled optgroup can't be chosen", r.error?.code === "NO_MATCH" && (await ev("document.getElementById('s').value")) !== "a", JSON.stringify(r));

// ---- find ----
await load(`<p>cat cat</p><p hidden>cat</p><p style="display:none">cat</p><p>Cat</p>`);
r = await run({ kind: "act-find", query: "cat" });
check("find counts every visible match and skips hidden ones", r.count === 3 && r.matches.length === 3 && !r.truncated, JSON.stringify(r));

// ---- shadow roots ----
await load(`<div id=h></div><span id=lab>Outer label</span>`);
await ev(`(() => { const r = document.getElementById('h').attachShadow({ mode: 'open' });
  r.innerHTML = '<span id=lab>Inner label</span><input aria-labelledby=lab><p>shadow needle</p>'; })()`);
s = await snap();
check("aria-labelledby resolves inside the element's shadow root", !!refOf(s, "textbox", "Inner label"), JSON.stringify(s.nodes));
r = await run({ kind: "act-find", query: "needle" });
check("find sees text in open shadow roots", r.count === 1, JSON.stringify(r));
await load(`<input id=a><div id=h></div><input id=c>`);
await ev(`(() => { const r = document.getElementById('h').attachShadow({ mode: 'open' }); r.innerHTML = '<input id=b>'; document.getElementById('a').focus(); })()`);
await run({ kind: "act-key", key: "Tab" });
check("Tab moves into an open shadow root in order", await ev("document.activeElement.id === 'h' && document.getElementById('h').shadowRoot.activeElement.id === 'b'"));

// ---- caret, selection, graphemes ----
await load(`<input id=i value="abcd">`);
await ev("(() => { const i = document.getElementById('i'); i.focus(); i.setSelectionRange(1, 1); })()");
await run({ kind: "act-key", key: "ArrowRight", modifiers: ["Shift"] });
check("Shift+ArrowRight extends the selection", await ev("[i.selectionStart, i.selectionEnd].join()") === "1,2");
await ev("i.setSelectionRange(1, 3)");
await run({ kind: "act-key", key: "ArrowRight" });
check("ArrowRight collapses a selection to its end", await ev("[i.selectionStart, i.selectionEnd].join()") === "3,3");
await run({ kind: "act-key", key: "Home", modifiers: ["Shift"] });
check("Shift+Home selects back to the start", await ev("[i.selectionStart, i.selectionEnd, i.selectionDirection].join()") === "0,3,backward");
await load(`<input id=i value="a😀">`);
await ev("(() => { const i = document.getElementById('i'); i.focus(); i.setSelectionRange(3, 3); })()");
await run({ kind: "act-key", key: "Backspace" });
check("Backspace deletes a whole emoji", await ev("i.value") === "a", JSON.stringify(await ev("i.value")));
await load(`<input id=i value="👍🏽x">`);
await ev("(() => { const i = document.getElementById('i'); i.focus(); i.setSelectionRange(0, 0); })()");
await run({ kind: "act-key", key: "Delete" });
check("Delete removes a whole grapheme cluster", await ev("i.value") === "x", JSON.stringify(await ev("i.value")));

// ---- cursor feedback ----
await load(`<button>Go</button>`);
await ev(`window.__said = []; window.__clicks = 0; window.__fxmcpCursor = { moveTo: async (el, n) => { window.__said.push(n); }, say: (n) => window.__said.push(n), click: () => window.__clicks++ };`);
r = await run({ kind: "act-click", selector: "#missing", cursor: {} });
check("a failed click shows failure, not a click", !!r.error && (await ev("window.__clicks")) === 0 && (await ev("window.__said.at(-1)")) === "That didn’t work", JSON.stringify(await ev("window.__said")));

await browser.close();
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
