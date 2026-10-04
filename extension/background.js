/* WebMCP Controller — background page.
 * Plain classic script (no modules). Firefox launches the companion helper
 * (native messaging host "webmcp_controller") on connectNative(); the helper
 * serves MCP over HTTP to your AI harness and relays tool calls here.
 *
 * Wire protocol (see shared/src/protocol.ts), framed by Firefox:
 *   ext -> host : { hello: {...} }                     (first message)
 *   ext -> host : { hostConfig: { token, port, ... } }  (after hello / on change)
 *   host -> ext : { hostStatus: {...} }                 (listener state, version, protocol)
 *   host -> ext : { hostExit: { reason } }              (about to quit, e.g. binary updated)
 *   host -> ext : { id, method, params }                (command)
 *   ext -> host : { id, ok, result|error }              (response)
 *   ext -> host : { event, data }                       (unsolicited event)
 */
(function () {
'use strict';

/* ------------------------------------------------------------------ setup */

var B = (typeof browser !== 'undefined') ? browser : chrome;
var HAS_PROMISES = (typeof browser !== 'undefined');
var EXT_VERSION = (function () { try { return B.runtime.getManifest().version; } catch (e) { return '0.0.0'; } })();
var EXT_ID_FALLBACK = 'webmcp-controller@hamb1y.github.io';
// Breaking wire-protocol version; keep in sync with PROTOCOL in shared/src/protocol.ts.
var PROTOCOL = 1;

var NATIVE_HOST = 'webmcp_controller';
var DEFAULT_PORT = 8901;
var DEFAULT_BIND = '127.0.0.1';
var BACKOFFS = [1000, 2000, 5000, 10000, 30000]; // ms, last value repeats
var MISSING_BACKOFF_MS = 60000; // helper not installed: retry slowly (Retry button is instant)
var START_TIMEOUT_MS = 20000;   // a helper that launched but never spoke is stuck: start it again

var CAPABILITIES = [
  'tabs.list', 'tabs.query', 'windows.list', 'active.tab',
  'tab.create', 'tab.update', 'tab.close', 'tab.duplicate', 'tab.move',
  'tab.pin', 'tab.unpin', 'tab.mute',
  'window.create', 'window.focus', 'window.remove',
  'nav.back', 'nav.forward', 'nav.reload',
  'page.snapshot', 'page.text', 'page.html', 'page.shot', 'page.info',
  'act.click', 'act.type', 'act.fillForm', 'act.select', 'act.hover',
  'act.scroll', 'act.key', 'act.wait', 'act.find',
  'bookmarks.search', 'bookmarks.create', 'bookmarks.remove',
  'history.search', 'downloads.list',
  'cookies.forTab', 'sessions.recentlyClosed', 'sessions.restore',
  'cursor.say'
];

/* Methods whose thought is shown by the content script as part of the action itself. */
var CONTENT_METHODS = /^(page\.(snapshot|text|html)|act\.)/;
/* Methods that navigate or close the page: a note shown there would vanish immediately. */
var NO_NOTE_METHODS = /^(tab\.(create|update|close|duplicate)|nav\.|window\.|sessions\.restore|page\.shot)/;

var CFG = { token: '', port: DEFAULT_PORT, bind: DEFAULT_BIND, allowWsl: false, confirmDestructive: true, showCursor: true };
var port = null;           // runtime.Port to the native helper
var backoffIdx = 0;
var connectTimer = null;
var startTimer = null;     // fires if a just-launched helper never says anything
var hostMissing = false;   // Firefox couldn't find/launch the helper
var hostStatus = null;     // last { hostStatus } from the helper
var hostRestarting = false; // helper said it's exiting to make way for an updated binary
var lastError = '';        // human-readable reason for the popup/options page
var connectedAt = 0;
var events = [];          // recent helper ups and downs, newest last, for the settings page
var EVENTS_MAX = 30;

/* Remember what happened to the helper, so "it stopped working" can be traced afterwards. */
function note(text, level) {
  var lastEv = events[events.length - 1];
  if (lastEv && lastEv.text === text) { lastEv.at = Date.now(); lastEv.count = (lastEv.count || 1) + 1; return; }
  events.push({ at: Date.now(), text: text, level: level || 'info' });
  if (events.length > EVENTS_MAX) events.splice(0, events.length - EVENTS_MAX);
}
var inflight = new Map();  // command id -> AbortController, for { cancel: id }
var cmdCount = 0;
var platform = { os: '', arch: '' };

/* ---------------------------------------------------------------- helpers */

/* Compare dotted versions numerically: <0 if a<b, 0 if equal, >0 if a>b. */
function cmpVersion(a, b) {
  var x = String(a || '0').split(/[.+-]/), y = String(b || '0').split(/[.+-]/);
  for (var i = 0; i < 3; i++) {
    var d = (parseInt(x[i], 10) || 0) - (parseInt(y[i], 10) || 0);
    if (d) return d;
  }
  return 0;
}

/* Is the running helper compatible with this add-on? */
function compat() {
  if (!hostStatus) return { state: 'unknown' };
  var hv = String(hostStatus.version || '0.0.0');
  var hp = Number(hostStatus.protocol) || 1; // helpers before 0.3.0 didn't send it; they speak 1
  if (hp < PROTOCOL) return { state: 'helper-old', helper: hv, addon: EXT_VERSION };
  if (hp > PROTOCOL) return { state: 'addon-old', helper: hv, addon: EXT_VERSION };
  if (cmpVersion(hv, EXT_VERSION) < 0) return { state: 'helper-update', helper: hv, addon: EXT_VERSION };
  return { state: 'ok', helper: hv, addon: EXT_VERSION };
}

function log() {
  try { console.log.apply(console, ['[fxmcp]'].concat([].slice.call(arguments))); } catch (e) {}
}

/* Promise adapter: browser.* returns promises; chrome.* needs callbacks. */
function pcall(fn) {
  var args = [].slice.call(arguments, 1);
  if (HAS_PROMISES) return fn.apply(null, args);
  return new Promise(function (resolve, reject) {
    args.push(function (res) {
      var err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(res);
    });
    try { fn.apply(null, args); } catch (e) { reject(e); }
  });
}

/* call(B.tabs, 'query', {...}) — late-bound so missing APIs throw cleanly. */
function call(obj, method) {
  var args = [].slice.call(arguments, 2);
  if (!obj || typeof obj[method] !== 'function') {
    throw be('NOT_SUPPORTED', 'API not available: ' + method);
  }
  return pcall.apply(null, [obj[method].bind(obj)].concat(args));
}

function num(v, dflt) {
  var n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function be(code, message) {
  var e = new Error(String(message));
  e.code = code;
  return e;
}

function toBridgeError(e) {
  if (e && typeof e.code === 'string') return { code: e.code, message: String(e.message || e.code) };
  var msg = String((e && e.message) || e);
  if (/no tab with id|tab .*not found|invalid tab id|no such tab/i.test(msg)) {
    return { code: 'TAB_NOT_FOUND', message: msg };
  }
  if (/timed out|timeout|timedout/i.test(msg)) return { code: 'TIMEOUT', message: msg };
  if (/missing host permission|privileged|not allowed|restricted|illegal url/i.test(msg)) {
    return { code: 'RESTRICTED_PAGE', message: msg };
  }
  if (/receiving end does not exist|could not establish connection|no content script/i.test(msg)) {
    return { code: 'NO_CONTENT_SCRIPT', message: msg };
  }
  return { code: 'INTERNAL', message: msg };
}

/* --------------------------------------------------------------- tab utils */

function toTabInfo(t) {
  if (!t) throw be('TAB_NOT_FOUND', 'Tab not found');
  return {
    id: t.id,
    windowId: t.windowId,
    index: t.index,
    url: t.url || '',
    title: t.title || '',
    active: !!t.active,
    pinned: !!t.pinned,
    audible: !!t.audible,
    muted: !!(t.mutedInfo && t.mutedInfo.muted),
    discarded: !!t.discarded,
    loading: t.status === 'loading'
  };
}

function toWindowInfo(w) {
  return {
    id: w.id,
    focused: !!w.focused,
    incognito: !!w.incognito,
    type: w.type || 'normal',
    tabCount: Array.isArray(w.tabs) ? w.tabs.length : 0
  };
}

/* Resolve a tab id, defaulting to the active tab of the focused window. */
async function resolveTab(tabId) {
  if (tabId !== undefined && tabId !== null && tabId !== '') {
    var id = Number(tabId);
    try {
      return await call(B.tabs, 'get', id);
    } catch (e) {
      throw be('TAB_NOT_FOUND', 'No tab with id ' + tabId);
    }
  }
  var cands = await call(B.tabs, 'query', { active: true, lastFocusedWindow: true });
  if (!cands || !cands.length) cands = await call(B.tabs, 'query', { active: true, currentWindow: true });
  if (!cands || !cands.length) cands = await call(B.tabs, 'query', { active: true });
  if (!cands || !cands.length) throw be('TAB_NOT_FOUND', 'No active tab');
  return cands[0];
}

var RESTRICTED_RE = /^(about|chrome|resource|moz-extension|view-source|jar|data|blob):/i;
var AMO_RE = /^https:\/\/addons\.mozilla\.org\//i;

function assertContentAllowed(tab) {
  var url = String((tab && tab.url) || '');
  if (RESTRICTED_RE.test(url)) {
    throw be('RESTRICTED_PAGE', 'Content scripting is forbidden on this page: ' + (url || '(no url yet)'));
  }
  if (AMO_RE.test(url)) {
    throw be('RESTRICTED_PAGE', 'Content scripting is forbidden on addons.mozilla.org');
  }
}

var CONTENT_FILES = ['content/cursor.js', 'content/ax.js'];

async function injectAx(tabId) {
  if (B.tabs && typeof B.tabs.executeScript === 'function') {
    for (var i = 0; i < CONTENT_FILES.length; i++) {
      await call(B.tabs, 'executeScript', tabId, { file: CONTENT_FILES[i] });
    }
    return;
  }
  if (B.scripting && typeof B.scripting.executeScript === 'function') {
    await call(B.scripting, 'executeScript', { target: { tabId: tabId }, files: CONTENT_FILES.slice() });
    return;
  }
  throw be('NO_CONTENT_SCRIPT', 'No script-injection API available');
}

function unwrapContentResponse(res) {
  if (res && res.__fxmcp === true) {
    if (res.ok) return res.result;
    var err = res.error || {};
    throw be(err.code || 'INTERNAL', err.message || 'Content script error');
  }
  return res;
}

/* Send a message to a tab's content script, re-injecting once on failure.
 * p is the command's params: when the AI cursor is on, the model's `thought`
 * rides along so the page can show it next to the cursor. */
async function sendToTab(tabId, p, msg) {
  if (CFG.showCursor && msg.kind !== 'cursor') {
    msg.cursor = { note: typeof p.thought === 'string' ? p.thought.slice(0, 300) : '' };
  }
  var firstErr = null;
  try {
    return unwrapContentResponse(await call(B.tabs, 'sendMessage', tabId, msg));
  } catch (e) {
    firstErr = e;
  }
  var m = String((firstErr && firstErr.message) || firstErr);
  if (/receiving end does not exist|could not establish connection|could not send|no response/i.test(m)) {
    try {
      await injectAx(tabId);
    } catch (inj) {
      throw be('NO_CONTENT_SCRIPT', 'No content script in tab ' + tabId + ' (restricted page?)');
    }
    try {
      return unwrapContentResponse(await call(B.tabs, 'sendMessage', tabId, msg));
    } catch (e2) {
      throw be('NO_CONTENT_SCRIPT', 'No content script in tab ' + tabId + ' (restricted page?)');
    }
  }
  throw firstErr;
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

/* The page went away (navigated, reloaded, closed) before its content script replied. */
var PAGE_GONE_RE = /destroyed before|message manager disconnected|context is inactive|page (was )?unloaded/i;
var READ_KINDS = /^(ax-snapshot|page-text|page-html|act-find)$/;

/* sendToTab, but an action that navigated the page before replying isn't reported as a failure
 * (the AI would repeat a click that worked), and a read retries once on the page that replaced it. */
async function sendToPage(tabId, p, msg) {
  try {
    return await sendToTab(tabId, p, msg);
  } catch (e) {
    if (!PAGE_GONE_RE.test(String((e && e.message) || e))) throw e;
    if (READ_KINDS.test(msg.kind)) {
      await sleep(500);
      return await sendToTab(tabId, p, msg);
    }
    if (msg.kind === 'act-wait') throw be('NAVIGATED', 'The page navigated away while waiting; take a new snapshot');
    return { done: true, pageChanged: true, note: 'The page navigated or reloaded as a result; take a new snapshot before using refs' };
  }
}

async function shoot(tab, p) {
  var format = p.format === 'jpeg' ? 'jpeg' : 'png';
  var opts = format === 'jpeg' ? { format: format, quality: 80 } : { format: format };
  // Fast path (Firefox 125+): capture a background tab without switching to it.
  if (!tab.active && B.tabs && typeof B.tabs.captureTab === 'function') {
    try {
      return { image: await call(B.tabs, 'captureTab', tab.id, opts), format: format, tabId: tab.id };
    } catch (e) { /* fall back to activate + captureVisibleTab */ }
  }
  var restoreId = null;
  if (!tab.active) {
    var prev = await call(B.tabs, 'query', { active: true, windowId: tab.windowId });
    if (prev && prev[0]) restoreId = prev[0].id;
    await call(B.tabs, 'update', tab.id, { active: true });
    await sleep(250); // let the compositor paint the newly active tab
  }
  try {
    var dataUrl = await call(B.tabs, 'captureVisibleTab', tab.windowId, opts);
    return { image: dataUrl, format: format, tabId: tab.id };
  } finally {
    // Hand the user's tab back so screenshots don't hijack what they're looking at.
    if (restoreId !== null && !p.keepActive) {
      try { await call(B.tabs, 'update', restoreId, { active: true }); } catch (e) {}
    }
  }
}

/* Best-effort cursor op on a tab that may have no content script: never injects, never throws. */
async function cursorOp(tabId, op, note) {
  try {
    return unwrapContentResponse(await call(B.tabs, 'sendMessage', tabId, { kind: 'cursor', op: op, note: note }));
  } catch (e) { return null; }
}

/* After a non-page method (tabs.list, history.search, ...), still show the model's thought. */
async function noteAfter(method, p) {
  if (!CFG.showCursor || typeof p.thought !== 'string' || !p.thought.trim()) return;
  if (CONTENT_METHODS.test(method) || NO_NOTE_METHODS.test(method) || method === 'cursor.say') return;
  try {
    var tab = await resolveTab(p.tabId);
    if (RESTRICTED_RE.test(String(tab.url || '')) || AMO_RE.test(String(tab.url || ''))) return;
    await sendToTab(tab.id, p, { kind: 'cursor', op: 'say', note: p.thought.slice(0, 300) });
  } catch (e) {}
}

/* Cursor turned off: clear it from every tab right away. */
async function hideCursors() {
  try {
    var tabs = await call(B.tabs, 'query', {});
    (tabs || []).forEach(function (t) { cursorOp(t.id, 'hide'); });
  } catch (e) {}
}

/* Resolve true once a tab finishes loading, false on timeout or abort.
 * The listener goes on before the navigation starts (so no event is missed);
 * call start(tabId) once the tab id is known. Events seen before that are
 * buffered. With checkNow, a tab that is already complete counts (used for new
 * tabs, which have no previous page whose 'complete' could be mistaken). */
function tabLoadWaiter(timeoutMs, signal, wantUrl) {
  var tabId = null, buffered = [], sawLoading = false, done = false, resolveFn;
  var promise = new Promise(function (r) { resolveFn = r; });
  var wantBlank = /^about:blank/i.test(String(wantUrl || ''));
  function finish(v) {
    if (done) return;
    done = true;
    clearTimeout(timer);
    try { B.tabs.onUpdated.removeListener(onUpd); } catch (e) {}
    if (signal) signal.removeEventListener('abort', onAbort);
    resolveFn(v);
  }
  // A new tab passes through about:blank; that 'complete' isn't the page we want.
  function placeholder(tab) {
    return !wantBlank && tab && /^about:blank/i.test(String(tab.url || ''));
  }
  function consider(info, tab) {
    // Ignore the 'complete' of the page we're navigating away from: require a
    // 'loading' first, or a URL change, before accepting 'complete'.
    if (info.status === 'loading' || info.url) sawLoading = true;
    if (info.status === 'complete' && sawLoading && !placeholder(tab)) finish(true);
  }
  function onUpd(id, info, tab) {
    if (done || !info) return;
    if (tabId === null) { buffered.push([id, info, tab]); return; }
    if (id === tabId) consider(info, tab);
  }
  function onAbort() { finish(false); }
  var timer = setTimeout(function () { finish(false); }, Math.max(1000, timeoutMs));
  B.tabs.onUpdated.addListener(onUpd);
  if (signal) {
    if (signal.aborted) finish(false);
    else signal.addEventListener('abort', onAbort);
  }
  return {
    promise: promise,
    start: function (id, checkNow) {
      tabId = id;
      var early = buffered;
      buffered = [];
      early.forEach(function (e) { if (!done && e[0] === id) consider(e[1], e[2]); });
      if (checkNow && !done) {
        call(B.tabs, 'get', id).then(function (t) {
          if (t && t.status === 'complete' && !placeholder(t)) finish(true);
        }).catch(function () {});
      }
    },
    cancel: function () { finish(false); }
  };
}

/* ---------------------------------------------------------------- handlers */

var handlers = {
  /* ---- inventory ---- */
  'tabs.list': async function () {
    var tabs = await call(B.tabs, 'query', {});
    return tabs.map(toTabInfo);
  },
  'tabs.query': async function (p) {
    var tabs = await call(B.tabs, 'query', {});
    var urlRe = null, titleRe = null;
    try {
      // A pathological pattern would freeze the whole add-on, so keep them short.
      if (String(p.urlPattern || '').length > 500 || String(p.titlePattern || '').length > 500) throw new Error('pattern longer than 500 characters');
      if (p.urlPattern) urlRe = new RegExp(String(p.urlPattern));
      if (p.titlePattern) titleRe = new RegExp(String(p.titlePattern));
    } catch (e) {
      throw be('INVALID_PARAMS', 'Bad regex in tabs.query: ' + e.message);
    }
    return tabs.filter(function (t) {
      if (urlRe && !urlRe.test(t.url || '')) return false;
      if (titleRe && !titleRe.test(t.title || '')) return false;
      if (p.audible !== undefined && !!t.audible !== !!p.audible) return false;
      if (p.pinned !== undefined && !!t.pinned !== !!p.pinned) return false;
      if (p.active !== undefined && !!t.active !== !!p.active) return false;
      return true;
    }).map(toTabInfo);
  },
  'windows.list': async function () {
    var wins = await call(B.windows, 'getAll', { populate: true });
    return wins.map(toWindowInfo);
  },
  'active.tab': async function () {
    return toTabInfo(await resolveTab(undefined));
  },

  /* ---- tab management ---- */
  'tab.create': async function (p, ctx) {
    var details = {};
    if (p.url !== undefined) details.url = String(p.url);
    if (p.active !== undefined) details.active = !!p.active;
    var waiter = details.url && p.waitForLoad ? tabLoadWaiter(num(p.timeoutMs, 20000), ctx.signal, details.url) : null;
    var created;
    try {
      created = await call(B.tabs, 'create', details);
    } catch (e) {
      if (waiter) waiter.cancel();
      throw e;
    }
    if (waiter) {
      waiter.start(created.id, true);
      var ok = await waiter.promise;
      var info = toTabInfo(await call(B.tabs, 'get', created.id));
      info.loadComplete = ok;
      return info;
    }
    return toTabInfo(created);
  },
  'tab.update': async function (p, ctx) {
    var tab = await resolveTab(p.tabId);
    var props = {};
    if (p.url !== undefined) props.url = String(p.url);
    if (p.active !== undefined) props.active = !!p.active;
    if (p.pinned !== undefined) props.pinned = !!p.pinned;
    var updated = tab;
    if (props.url !== undefined && p.waitForLoad) {
      var loaded = tabLoadWaiter(num(p.timeoutMs, 20000), ctx.signal, props.url);
      loaded.start(tab.id, false);
      try {
        await call(B.tabs, 'update', tab.id, props);
      } catch (e) {
        loaded.cancel();
        throw e;
      }
      var ok = await loaded.promise;
      var info = toTabInfo(await call(B.tabs, 'get', tab.id));
      info.loadComplete = ok;
      return info;
    }
    if (Object.keys(props).length) updated = await call(B.tabs, 'update', tab.id, props);
    if (props.active && updated) {
      try { await call(B.windows, 'update', updated.windowId, { focused: true }); } catch (e) {}
    }
    return toTabInfo(updated || tab);
  },
  'tab.close': async function (p) {
    var ids;
    if (Array.isArray(p.tabIds)) ids = p.tabIds.map(Number);
    else if (p.tabId !== undefined) ids = [Number(p.tabId)];
    else ids = [(await resolveTab(undefined)).id];
    try {
      await call(B.tabs, 'remove', ids);
    } catch (e) {
      throw be('TAB_NOT_FOUND', 'Could not close tab(s): ' + (e.message || e));
    }
    return { closed: ids };
  },
  'tab.duplicate': async function (p) {
    var tab = await resolveTab(p.tabId);
    return toTabInfo(await call(B.tabs, 'duplicate', tab.id));
  },
  'tab.move': async function (p) {
    if (p.index === undefined) throw be('INVALID_PARAMS', 'tab.move requires index');
    var tab = await resolveTab(p.tabId);
    var props = { index: Number(p.index) };
    if (p.windowId !== undefined) props.windowId = Number(p.windowId);
    var moved = await call(B.tabs, 'move', tab.id, props);
    var t = Array.isArray(moved) ? moved[0] : moved;
    return toTabInfo(t || tab);
  },
  'tab.pin': async function (p) {
    var tab = await resolveTab(p.tabId);
    return toTabInfo(await call(B.tabs, 'update', tab.id, { pinned: true }));
  },
  'tab.unpin': async function (p) {
    var tab = await resolveTab(p.tabId);
    return toTabInfo(await call(B.tabs, 'update', tab.id, { pinned: false }));
  },
  'tab.mute': async function (p) {
    var tab = await resolveTab(p.tabId);
    var muted = p.muted !== undefined ? !!p.muted : true;
    // NOTE: Firefox tabs.update does NOT support `muted` (Chrome-only).
    // Correct API: browser.tabs.updateMutedInfo(tabId, { muted }).
    if (B.tabs && typeof B.tabs.updateMutedInfo === 'function') {
      await call(B.tabs, 'updateMutedInfo', tab.id, { muted: muted });
    } else {
      // chrome fallback: chrome.tabs.update supports `muted`.
      await call(B.tabs, 'update', tab.id, { muted: muted });
    }
    try {
      return toTabInfo(await call(B.tabs, 'get', tab.id));
    } catch (e) {
      return { muted: muted, tabId: tab.id };
    }
  },

  /* ---- windows ---- */
  'window.create': async function (p) {
    var w = await call(B.windows, 'create', p.url ? { url: String(p.url) } : {});
    return {
      id: w.id,
      focused: !!w.focused,
      incognito: !!w.incognito,
      type: w.type || 'normal',
      tabCount: Array.isArray(w.tabs) ? w.tabs.length : 1
    };
  },
  'window.focus': async function (p) {
    if (p.windowId === undefined) throw be('INVALID_PARAMS', 'window.focus requires windowId');
    await call(B.windows, 'update', Number(p.windowId), { focused: true });
    return { focused: true, windowId: Number(p.windowId) };
  },
  'window.remove': async function (p) {
    if (p.windowId === undefined) throw be('INVALID_PARAMS', 'window.remove requires windowId');
    await call(B.windows, 'remove', Number(p.windowId));
    return { removed: true, windowId: Number(p.windowId) };
  },

  /* ---- navigation ---- */
  'nav.back': async function (p) {
    var tab = await resolveTab(p.tabId);
    await call(B.tabs, 'goBack', tab.id);
    return { navigated: true, tabId: tab.id };
  },
  'nav.forward': async function (p) {
    var tab = await resolveTab(p.tabId);
    await call(B.tabs, 'goForward', tab.id);
    return { navigated: true, tabId: tab.id };
  },
  'nav.reload': async function (p) {
    var tab = await resolveTab(p.tabId);
    if (p.bypassCache !== undefined) await call(B.tabs, 'reload', tab.id, { bypassCache: !!p.bypassCache });
    else await call(B.tabs, 'reload', tab.id);
    return { reloaded: true, tabId: tab.id };
  },

  /* ---- understanding ---- */
  'page.snapshot': async function (p) {
    var tab = await resolveTab(p.tabId);
    assertContentAllowed(tab);
    return await sendToPage(tab.id, p, {
      kind: 'ax-snapshot',
      compact: p.compact !== undefined ? !!p.compact : true,
      maxChars: num(p.maxChars, 50000)
    });
  },
  'page.text': async function (p) {
    var tab = await resolveTab(p.tabId);
    assertContentAllowed(tab);
    return await sendToPage(tab.id, p, { kind: 'page-text', maxChars: num(p.maxChars, 50000) });
  },
  'page.html': async function (p) {
    var tab = await resolveTab(p.tabId);
    assertContentAllowed(tab);
    return await sendToPage(tab.id, p, {
      kind: 'page-html',
      selector: p.selector,
      maxChars: num(p.maxChars, 50000)
    });
  },
  'page.shot': async function (p) {
    var tab = await resolveTab(p.tabId);
    // Keep the AI cursor out of the picture.
    var concealed = !!(await cursorOp(tab.id, 'conceal'));
    try {
      return await shoot(tab, p);
    } finally {
      if (concealed) cursorOp(tab.id, 'reveal');
    }
  },
  'cursor.say': async function (p) {
    var tab = await resolveTab(p.tabId);
    var note = String(p.note || p.thought || '').trim();
    if (!note) throw be('INVALID_PARAMS', 'cursor.say requires note');
    if (!CFG.showCursor) return { shown: false, reason: 'The user turned the AI cursor off' };
    assertContentAllowed(tab);
    return await sendToTab(tab.id, p, { kind: 'cursor', op: 'say', note: note.slice(0, 300) });
  },
  'page.info': async function (p) {
    var tab = await resolveTab(p.tabId);
    return {
      id: tab.id,
      url: tab.url || '',
      title: tab.title || '',
      status: tab.status || '',
      windowId: tab.windowId,
      active: !!tab.active,
      pinned: !!tab.pinned,
      audible: !!tab.audible,
      muted: !!(tab.mutedInfo && tab.mutedInfo.muted),
      discarded: !!tab.discarded,
      index: tab.index
    };
  },

  /* ---- acting (content script does the DOM work) ---- */
  'act.click': async function (p) {
    var tab = await resolveTab(p.tabId);
    assertContentAllowed(tab);
    return await sendToPage(tab.id, p, { kind: 'act-click', ref: p.ref, selector: p.selector, generation: p.generation, button: p.button || 'left' });
  },
  'act.type': async function (p) {
    var tab = await resolveTab(p.tabId);
    assertContentAllowed(tab);
    return await sendToPage(tab.id, p, {
      kind: 'act-type', ref: p.ref, selector: p.selector, generation: p.generation,
      text: (p.text === undefined || p.text === null) ? '' : String(p.text),
      submit: !!p.submit
    });
  },
  'act.fillForm': async function (p) {
    if (!Array.isArray(p.fields)) throw be('INVALID_PARAMS', 'act.fillForm requires fields[]');
    var tab = await resolveTab(p.tabId);
    assertContentAllowed(tab);
    return await sendToPage(tab.id, p, { kind: 'act-fillForm', fields: p.fields, generation: p.generation, submit: !!p.submit });
  },
  'act.select': async function (p) {
    if (!Array.isArray(p.values)) throw be('INVALID_PARAMS', 'act.select requires values[]');
    var tab = await resolveTab(p.tabId);
    assertContentAllowed(tab);
    return await sendToPage(tab.id, p, {
      kind: 'act-select', ref: p.ref, selector: p.selector, generation: p.generation,
      values: p.values.map(String)
    });
  },
  'act.hover': async function (p) {
    var tab = await resolveTab(p.tabId);
    assertContentAllowed(tab);
    return await sendToPage(tab.id, p, { kind: 'act-hover', ref: p.ref, selector: p.selector, generation: p.generation });
  },
  'act.scroll': async function (p) {
    var tab = await resolveTab(p.tabId);
    assertContentAllowed(tab);
    return await sendToPage(tab.id, p, {
      kind: 'act-scroll', ref: p.ref, selector: p.selector, generation: p.generation,
      direction: p.direction, pixels: p.pixels, to: p.to
    });
  },
  'act.key': async function (p) {
    if (p.key === undefined || p.key === null || p.key === '') {
      throw be('INVALID_PARAMS', 'act.key requires key');
    }
    var tab = await resolveTab(p.tabId);
    assertContentAllowed(tab);
    return await sendToPage(tab.id, p, { kind: 'act-key', key: String(p.key), modifiers: p.modifiers });
  },
  'act.wait': async function (p, ctx) {
    var tab = await resolveTab(p.tabId);
    assertContentAllowed(tab);
    var stop = function () {
      call(B.tabs, 'sendMessage', tab.id, { kind: 'cancel', opId: ctx.id }).catch(function () {});
    };
    ctx.signal.addEventListener('abort', stop);
    try {
      return await sendToPage(tab.id, p, {
        kind: 'act-wait', text: p.text, selector: p.selector, opId: ctx.id,
        timeoutMs: num(p.timeoutMs, 10000)
      });
    } finally {
      ctx.signal.removeEventListener('abort', stop);
    }
  },
  'act.find': async function (p) {
    if (p.query === undefined || p.query === null || String(p.query) === '') {
      throw be('INVALID_PARAMS', 'act.find requires query');
    }
    var tab = await resolveTab(p.tabId);
    assertContentAllowed(tab);
    return await sendToPage(tab.id, p, { kind: 'act-find', query: String(p.query) });
  },

  /* ---- browser data ---- */
  'bookmarks.search': async function (p) {
    var q = p.query !== undefined ? p.query : '';
    return await call(B.bookmarks, 'search', q);
  },
  'bookmarks.create': async function (p) {
    var d = {};
    if (p.title !== undefined) d.title = String(p.title);
    if (p.url !== undefined) d.url = String(p.url);
    if (p.parentId !== undefined) d.parentId = String(p.parentId);
    return await call(B.bookmarks, 'create', d);
  },
  'bookmarks.remove': async function (p) {
    if (p.id === undefined) throw be('INVALID_PARAMS', 'bookmarks.remove requires id');
    await call(B.bookmarks, 'remove', String(p.id));
    return { removed: true, id: String(p.id) };
  },
  'history.search': async function (p) {
    var h = { text: p.query !== undefined ? String(p.query) : '', maxResults: num(p.maxResults, 20) };
    if (p.startTime !== undefined) h.startTime = Number(p.startTime);
    return await call(B.history, 'search', h);
  },
  'downloads.list': async function (p) {
    var limit = num(p.limit, 20);
    try {
      return await call(B.downloads, 'search', { orderBy: ['-startTime'], limit: limit });
    } catch (e) {
      var all = await call(B.downloads, 'search', {});
      return (all || []).slice(0, limit);
    }
  },
  'cookies.forTab': async function (p) {
    var tab = await resolveTab(p.tabId);
    var url = String(tab.url || '');
    if (!/^https?:/i.test(url)) return [];
    // The tab's own cookie jar (containers, private windows), across first-party
    // isolation, including cookies partitioned under this site (CHIPS / Total
    // Cookie Protection). Older Firefox lacks some keys; drop them and retry.
    var q = { url: url.split('#')[0], firstPartyDomain: null, partitionKey: {} };
    if (tab.cookieStoreId) q.storeId = tab.cookieStoreId;
    var cookies;
    for (var attempt = 0; ; attempt++) {
      try {
        cookies = await call(B.cookies, 'getAll', q);
        break;
      } catch (e) {
        if (attempt === 0 && 'partitionKey' in q) { delete q.partitionKey; continue; }
        if (attempt <= 1 && 'firstPartyDomain' in q) { delete q.firstPartyDomain; continue; }
        throw e;
      }
    }
    var host = '';
    try { host = new URL(url).hostname; } catch (e) {}
    return (cookies || []).filter(function (c) {
      var site = c.partitionKey && c.partitionKey.topLevelSite;
      if (!site) return true;
      try {
        var h = new URL(site).hostname;
        return host === h || host.endsWith('.' + h);
      } catch (e) {
        return false;
      }
    });
  },
  'sessions.recentlyClosed': async function (p) {
    return await call(B.sessions, 'getRecentlyClosed', { maxResults: num(p.limit, 10) });
  },
  'sessions.restore': async function (p) {
    if (p.sessionId === undefined) throw be('INVALID_PARAMS', 'sessions.restore requires sessionId');
    return await call(B.sessions, 'restore', String(p.sessionId));
  }
};

async function onCommand(cmd, ctx) {
  var handler = handlers[cmd.method];
  if (!handler) throw be('UNKNOWN_METHOD', 'Unknown method: ' + cmd.method);
  var params = (cmd.params && typeof cmd.params === 'object') ? cmd.params : {};
  cmdCount += 1;
  var result = await handler(params, ctx);
  noteAfter(cmd.method, params);
  return result;
}

/* ------------------------------------------------------------ native port */

function send(obj) {
  if (!port) return;
  try { port.postMessage(obj); } catch (e) { log('postMessage failed: ' + (e.message || e)); }
}

function sendEvent(evt) { send(evt); }

async function handleIncoming(msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.hostStatus && typeof msg.hostStatus === 'object') {
    var prev = hostStatus;
    hostStatus = msg.hostStatus;
    if (!prev) note('Helper v' + (hostStatus.version || '?') + ' running');
    if (hostStatus.error && (!prev || prev.error !== hostStatus.error)) note(hostStatus.error, 'bad');
    else if (hostStatus.listening && (!prev || !prev.listening || prev.url !== hostStatus.url)) note('Listening on ' + hostStatus.url, 'ok');
    lastError = hostStatus.error || '';
    var c = compat();
    if (c.state === 'helper-old') lastError = 'Helper app v' + c.helper + ' is too old for this add-on — run the install command again';
    if (c.state === 'addon-old') lastError = 'This add-on is older than the helper app (v' + c.helper + ') — update the add-on';
    updateBadge();
    return;
  }
  if (msg.hostExit && typeof msg.hostExit === 'object') {
    // Expected exit (e.g. its binary was just updated): relaunch quickly, no error.
    hostRestarting = true;
    log('helper exiting: ' + (msg.hostExit.reason || '?'));
    note(msg.hostExit.reason === 'updated'
      ? 'Helper updated' + (msg.hostExit.version ? ' to v' + msg.hostExit.version : '') + ', restarting it'
      : 'Helper is shutting down');
    return;
  }
  if (typeof msg.cancel === 'string') {
    // The helper gave up on a command (client cancelled or disconnected).
    var ctl = inflight.get(msg.cancel);
    if (ctl) ctl.abort();
    return;
  }
  if (msg.id !== undefined && typeof msg.method === 'string') {
    var cs = compat().state;
    if (cs === 'helper-old' || cs === 'addon-old') {
      send({ id: msg.id, ok: false, error: { code: 'PROTOCOL_MISMATCH', message: lastError } });
      return;
    }
    var ac = new AbortController();
    var from = port; // a reply belongs to the helper that asked, not to one started since
    inflight.set(msg.id, ac);
    try {
      var result = await onCommand(msg, { id: String(msg.id), signal: ac.signal });
      if (port === from) send({ id: msg.id, ok: true, result: result === undefined ? null : result });
    } catch (e) {
      if (port === from) send({ id: msg.id, ok: false, error: toBridgeError(e) });
    } finally {
      if (inflight.get(msg.id) === ac) inflight.delete(msg.id);
    }
  }
}

function scheduleReconnect() {
  if (connectTimer) return;
  var delay = hostRestarting ? 500
    : hostMissing ? MISSING_BACKOFF_MS
    : BACKOFFS[Math.min(backoffIdx, BACKOFFS.length - 1)];
  backoffIdx += 1;
  log('reconnect in ' + delay + 'ms');
  connectTimer = setTimeout(function () {
    connectTimer = null;
    connect();
  }, delay);
}

/* The helper is gone: stop whatever it asked for, nobody is waiting for the answer. */
function abortInflight() {
  inflight.forEach(function (ac) { try { ac.abort(); } catch (e) {} });
  inflight.clear();
}

function clearStartTimer() {
  if (startTimer) { clearTimeout(startTimer); startTimer = null; }
}

/* Drop the current helper (if any) and launch it again right away. */
function reconnectNow() {
  backoffIdx = 0;
  if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
  clearStartTimer();
  var old = port;
  port = null;
  connectedAt = 0;
  abortInflight();
  if (old) { try { old.disconnect(); } catch (e) {} }
  connect();
}

async function buildHello() {
  var ffVersion = 'unknown';
  try {
    if (B.runtime && typeof B.runtime.getBrowserInfo === 'function') {
      var info = await call(B.runtime, 'getBrowserInfo');
      if (info && info.version) ffVersion = String(info.version);
    }
  } catch (e) {}
  var extId = EXT_ID_FALLBACK;
  try { if (B.runtime && B.runtime.id) extId = String(B.runtime.id); } catch (e) {}
  return {
    hello: {
      extensionId: extId,
      version: EXT_VERSION,
      protocol: PROTOCOL,
      token: CFG.token,
      profile: 'default',
      firefoxVersion: ffVersion,
      capabilities: CAPABILITIES.slice()
    }
  };
}

function hostConfigMessage() {
  return {
    hostConfig: {
      token: CFG.token,
      port: CFG.port,
      bind: CFG.bind,
      allowWsl: CFG.allowWsl,
      confirmDestructive: CFG.confirmDestructive
    }
  };
}

function isMissingHostError(text) {
  return /no such native application|not found|manifest|does not exist|access to the specified native/i.test(text || '');
}

function connect() {
  if (port) return;
  var p;
  try {
    p = B.runtime.connectNative(NATIVE_HOST);
  } catch (e) {
    hostMissing = true;
    lastError = 'Could not start the helper: ' + (e.message || e);
    note(lastError, 'bad');
    updateBadge();
    scheduleReconnect();
    return;
  }
  port = p;
  connectedAt = 0;
  hostStatus = null;
  lastError = '';
  clearStartTimer();
  startTimer = setTimeout(function () {
    startTimer = null;
    if (p !== port || connectedAt) return;
    note('Helper didn’t answer within ' + (START_TIMEOUT_MS / 1000) + ' s; starting it again', 'bad');
    port = null;
    try { p.disconnect(); } catch (e) {}
    lastError = 'Helper didn’t start';
    updateBadge();
    scheduleReconnect();
  }, START_TIMEOUT_MS);
  p.onMessage.addListener(function (msg) {
    if (p !== port) return;
    if (!connectedAt) clearStartTimer();
    if (hostMissing || !connectedAt) {
      // First message proves the helper really launched.
      hostMissing = false;
      backoffIdx = 0;
      connectedAt = Date.now();
    }
    handleIncoming(msg);
  });
  p.onDisconnect.addListener(function (dp) {
    if (p !== port) return; // superseded by reconnectNow()
    var err = (dp && dp.error && dp.error.message) || (B.runtime.lastError && B.runtime.lastError.message) || '';
    log('helper disconnected: ' + (err || 'exited'));
    port = null;
    clearStartTimer();
    abortInflight();
    var wasUp = !!connectedAt;
    connectedAt = 0;
    hostStatus = null;
    if (hostRestarting) {
      hostMissing = false;
      lastError = '';
    } else if (!wasUp && (isMissingHostError(err) || !err)) {
      if (!hostMissing) note('Helper app not found', 'bad');
      hostMissing = true;
      lastError = 'Helper app not installed';
    } else {
      hostMissing = false;
      lastError = 'Helper stopped' + (err ? ': ' + err : '');
      note(lastError + (wasUp ? '' : ' while starting'), 'bad');
    }
    updateBadge();
    scheduleReconnect();
    hostRestarting = false;
  });
  buildHello().then(function (hello) {
    if (p !== port) return;
    send(hello);
    send(hostConfigMessage());
    sendEvent({ event: 'extension.ready', data: { version: EXT_VERSION } });
  }).catch(function (e) {
    log('hello failed: ' + (e.message || e));
  });
  updateBadge();
}

function isConnected() {
  return !!(port && connectedAt);
}

function isCompatible() {
  var s = compat().state;
  return s === 'ok' || s === 'helper-update';
}

function isListening() {
  return !!(isConnected() && hostStatus && hostStatus.listening && isCompatible());
}

/* Toolbar badge: nothing when serving MCP, "!" otherwise. */
function updateBadge() {
  var ba = B.browserAction;
  if (!ba) return;
  var on = isListening();
  var update = on && compat().state === 'helper-update';
  var why = on ? 'serving ' + hostStatus.url + (update ? ' (helper update available)' : '')
    : (lastError || (port ? 'starting helper…' : 'not connected'));
  try {
    ba.setBadgeText({ text: on ? (update ? '↑' : '') : '!' });
    ba.setBadgeBackgroundColor({ color: update ? '#2563eb' : hostMissing ? '#b45309' : '#c50042' });
    ba.setTitle({ title: 'WebMCP Controller — ' + why });
  } catch (e) {}
}

/* ------------------------------------------------------------------ events */

function wireTabEvents() {
  try {
    if (B.tabs && B.tabs.onUpdated) {
      B.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
        if (changeInfo && (changeInfo.status === 'complete' || changeInfo.url)) {
          sendEvent({
            event: 'tab.updated',
            data: {
              tabId: tabId,
              windowId: tab ? tab.windowId : undefined,
              status: changeInfo.status || (tab && tab.status),
              url: changeInfo.url || (tab && tab.url)
            }
          });
        }
      });
    }
    if (B.tabs && B.tabs.onRemoved) {
      B.tabs.onRemoved.addListener(function (tabId, removeInfo) {
        sendEvent({
          event: 'tab.removed',
          data: {
            tabId: tabId,
            windowId: removeInfo && removeInfo.windowId,
            isWindowClosing: !!(removeInfo && removeInfo.isWindowClosing)
          }
        });
      });
    }
    if (B.tabs && B.tabs.onActivated) {
      B.tabs.onActivated.addListener(function (activeInfo) {
        sendEvent({
          event: 'tab.activated',
          data: { tabId: activeInfo.tabId, windowId: activeInfo.windowId }
        });
      });
    }
    if (B.downloads && B.downloads.onChanged) {
      B.downloads.onChanged.addListener(function (delta) {
        if (delta && delta.state && delta.state.current === 'complete') {
          call(B.downloads, 'search', { id: delta.id }).then(function (found) {
            var extra = {};
            if (found && found[0]) {
              extra = { filename: found[0].filename, url: found[0].url, bytesReceived: found[0].bytesReceived };
            }
            var data = { id: delta.id };
            for (var k in extra) data[k] = extra[k];
            sendEvent({ event: 'download.done', data: data });
          }).catch(function () {
            sendEvent({ event: 'download.done', data: { id: delta.id } });
          });
        }
      });
    }
  } catch (e) {
    log('event wiring failed: ' + (e.message || e));
  }
}

/* ---------------------------------------------------------- config + boot */

function randomToken() {
  var bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.prototype.map.call(bytes, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
}

function validPort(v) {
  var n = Number(v);
  return Number.isInteger(n) && n >= 1024 && n <= 65535 ? n : 0;
}

function validBind(v) {
  var s = String(v || '').trim();
  if (s === 'localhost') return '127.0.0.1';
  if (s === '::' || s === '::1') return s;
  var parts = s.split('.');
  return parts.length === 4 && parts.every(function (o) { return /^\d{1,3}$/.test(o) && Number(o) <= 255; }) ? s : '';
}

async function loadConfig() {
  var got = {};
  try {
    got = (await call(B.storage.local, 'get', ['mcpToken', 'mcpPort', 'mcpBind', 'mcpAllowWsl', 'mcpConfirm', 'mcpShowCursor'])) || {};
  } catch (e) {}
  CFG.token = (typeof got.mcpToken === 'string' && got.mcpToken.length >= 16) ? got.mcpToken : '';
  CFG.port = validPort(got.mcpPort) || DEFAULT_PORT;
  CFG.bind = validBind(got.mcpBind) || DEFAULT_BIND;
  CFG.allowWsl = got.mcpAllowWsl === true;
  CFG.confirmDestructive = got.mcpConfirm !== false;
  CFG.showCursor = got.mcpShowCursor !== false;
  if (!CFG.token) {
    CFG.token = randomToken();
    try { await call(B.storage.local, 'set', { mcpToken: CFG.token }); } catch (e) {}
  }
  try {
    var pi = await call(B.runtime, 'getPlatformInfo');
    if (pi) platform = { os: pi.os || '', arch: pi.arch || '' };
  } catch (e) {}
}

function statusSnapshot() {
  return {
    version: EXT_VERSION,
    protocol: PROTOCOL,
    compat: compat(),
    platform: platform,
    hostMissing: hostMissing,
    connected: isConnected(),
    starting: !!(port && !connectedAt),
    listening: isListening(),
    host: hostStatus,
    url: hostStatus && hostStatus.url ? hostStatus.url : '',
    token: CFG.token,
    port: CFG.port,
    bind: CFG.bind,
    allowWsl: CFG.allowWsl,
    confirmDestructive: CFG.confirmDestructive,
    showCursor: CFG.showCursor,
    defaults: { port: DEFAULT_PORT, bind: DEFAULT_BIND },
    lastError: lastError,
    connectedAt: connectedAt,
    commands: cmdCount,
    events: events.slice()
  };
}

/* Push settings to a running helper without relaunching it. */
function applyConfig() {
  if (isConnected()) send(hostConfigMessage());
  else reconnectNow();
}

/* Only our own extension pages may reconfigure the bridge — never content scripts. Checked by the
 * sender's URL, not by sender.tab: the settings page opens in a tab too. */
function fromOwnPage(sender) {
  var base = B.runtime.getURL('');
  return !!(sender && sender.id === B.runtime.id && typeof sender.url === 'string' && sender.url.indexOf(base) === 0);
}

if (B.runtime && B.runtime.onMessage) {
  B.runtime.onMessage.addListener(function (msg, sender) {
    if (!fromOwnPage(sender)) return undefined;
    var type = msg && msg.type;
    if (type === 'get-status') return Promise.resolve(statusSnapshot());
    if (type === 'probe') {
      // Quiet re-check from an open popup/settings page while the helper is missing.
      if (!port) {
        if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
        connect();
      }
      return sleep(300).then(statusSnapshot);
    }
    if (type === 'reconnect') {
      hostMissing = false;
      reconnectNow();
      return sleep(400).then(statusSnapshot);
    }
    if (type === 'set-config') {
      // Validate everything before changing anything, so a bad field can't leave half a config applied.
      var data = {};
      var p = msg.port !== undefined ? validPort(msg.port) : 0;
      if (msg.port !== undefined && !p) return Promise.resolve({ error: 'Port must be a number between 1024 and 65535' });
      var b = msg.bind !== undefined ? validBind(msg.bind) : '';
      if (msg.bind !== undefined && !b) return Promise.resolve({ error: 'Bind address must be an IP like 127.0.0.1 or 0.0.0.0' });
      if (p) CFG.port = data.mcpPort = p;
      if (b) CFG.bind = data.mcpBind = b;
      if (typeof msg.allowWsl === 'boolean') CFG.allowWsl = data.mcpAllowWsl = msg.allowWsl;
      if (typeof msg.confirmDestructive === 'boolean') CFG.confirmDestructive = data.mcpConfirm = msg.confirmDestructive;
      if (typeof msg.showCursor === 'boolean') {
        CFG.showCursor = data.mcpShowCursor = msg.showCursor;
        if (!msg.showCursor) hideCursors();
        if (msg.port === undefined && msg.bind === undefined && msg.allowWsl === undefined &&
            msg.confirmDestructive === undefined) {
          // Extension-only setting: no need to touch the helper.
          return call(B.storage.local, 'set', data).then(statusSnapshot);
        }
      }
      return call(B.storage.local, 'set', data).then(function () {
        applyConfig();
        return sleep(400).then(statusSnapshot);
      });
    }
    if (type === 'regenerate-token') {
      CFG.token = randomToken();
      return call(B.storage.local, 'set', { mcpToken: CFG.token }).then(function () {
        applyConfig();
        return sleep(200).then(statusSnapshot);
      });
    }
    return undefined;
  });
}

wireTabEvents();
updateBadge();
loadConfig().then(connect);

})();
