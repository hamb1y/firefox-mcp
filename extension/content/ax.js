/* Firefox MCP Bridge — content script (isolated world).
 * Plain classic script (no modules). Idempotent: safe to re-inject.
 * Owns AX `ref` numbering per snapshot `generation`.
 */
(function () {
'use strict';

if (window.__fxmcp) return;
window.__fxmcp = true;

var B = (typeof browser !== 'undefined') ? browser : chrome;

var generation = 0;
var lastGeneration = '';
var refMap = new Map();      // ref number -> Element
var elToRef = new WeakMap(); // Element -> ref number (for act.find)

/* ------------------------------------------------------------------ errors */

function be(code, message) {
  var e = new Error(String(message));
  e.code = code;
  return e;
}

function errToObj(e) {
  if (e && typeof e.code === 'string') return { code: e.code, message: String(e.message || e.code) };
  return { code: 'INTERNAL', message: String((e && e.message) || e) };
}

/* ------------------------------------------------------------------ helpers */

function visible(el) {
  if (!(el instanceof Element)) return false;
  if (el.hasAttribute('hidden')) return false;
  if (el.getAttribute('aria-hidden') === 'true') return false;
  var cs;
  try { cs = window.getComputedStyle(el); } catch (e) { return true; }
  if (!cs || cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
  try {
    var r = el.getBoundingClientRect();
    if (r && (r.width > 0 || r.height > 0)) return true;
  } catch (e) { return true; }
  // Zero-rect but focusable/fixed elements (e.g. position:fixed) still count.
  try {
    if (cs.position === 'fixed') return true;
    if (el === document.activeElement) return true;
  } catch (e) {}
  return false;
}

var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, HEAD: 1, META: 1, LINK: 1 };

var HEADING_RE = /^H([1-6])$/;

function inputRole(type) {
  switch (type) {
    case 'checkbox': return 'checkbox';
    case 'radio': return 'radio';
    case 'button': case 'submit': case 'reset': case 'image': return 'button';
    case 'range': return 'slider';
    case 'number': return 'spinbutton';
    case 'search': return 'searchbox';
    case 'password': case 'email': case 'tel': case 'url': case 'text': default: return 'textbox';
  }
}

function tagRole(el, compact) {
  var explicit = el.getAttribute && el.getAttribute('role');
  if (explicit) return explicit.trim().split(/\s+/)[0];
  var tag = el.tagName;
  if (tag === 'A') return 'link';
  if (tag === 'BUTTON') return 'button';
  if (tag === 'INPUT') return inputRole(String(el.type || 'text').toLowerCase());
  if (tag === 'SELECT') return el.multiple ? 'listbox' : 'combobox';
  if (tag === 'TEXTAREA') return 'textbox';
  if (tag === 'IMG') return 'img';
  if (tag === 'FORM') return 'form';
  if (tag === 'TABLE') return 'table';
  if (tag === 'SUMMARY') return 'button';
  if (tag === 'LABEL') return 'label';
  if (tag === 'UL' || tag === 'OL') return 'list';
  if (tag === 'LI') return 'listitem';
  if (tag === 'DETAILS') return 'group';
  if (tag === 'FIELDSET') return 'group';
  if (tag === 'OPTION') return 'option';
  var m = HEADING_RE.exec(tag);
  if (m) return 'heading';
  if (el.isContentEditable) return 'textbox';
  return compact ? '' : 'text';
}

function isInteresting(el) {
  var tag = el.tagName;
  if (tag === 'A' || tag === 'BUTTON' || tag === 'INPUT' || tag === 'SELECT' ||
      tag === 'TEXTAREA' || tag === 'FORM' || tag === 'TABLE' || tag === 'IMG' ||
      tag === 'SUMMARY' || tag === 'LABEL' || tag === 'LI' || tag === 'DETAILS') return true;
  if (HEADING_RE.test(tag)) return true;
  if (el.hasAttribute && (el.hasAttribute('role') || el.hasAttribute('tabindex') ||
      el.hasAttribute('onclick') || el.isContentEditable)) return true;
  return false;
}

/* Direct-text container for non-compact mode (leaf-ish text blocks). */
function hasDirectText(el) {
  var tag = el.tagName;
  if (/^(DIV|SPAN|P|TD|TH|LI|DT|DD|H[1-6]|BUTTON|A|LABEL|OPTION|LEGEND|CAPTION|FIGCAPTION|BLOCKQUOTE|PRE|CODE|EM|STRONG|SMALL|B|I|U)$/.test(tag)) {
    for (var n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3 && n.nodeValue && n.nodeValue.trim()) return true;
    }
  }
  return false;
}

function textOf(el) {
  try {
    var t = (el.innerText !== undefined) ? el.innerText : el.textContent;
    return String(t || '').trim().replace(/\s+/g, ' ');
  } catch (e) { return ''; }
}

function computeName(el, tag) {
  var labelledby = el.getAttribute && el.getAttribute('aria-labelledby');
  if (labelledby) {
    var parts = [];
    labelledby.trim().split(/\s+/).forEach(function (id) {
      var lab = document.getElementById(id);
      if (lab) parts.push(textOf(lab));
    });
    if (parts.length) return parts.join(' ').slice(0, 100);
  }
  var aria = el.getAttribute && el.getAttribute('aria-label');
  if (aria && aria.trim()) return aria.trim().slice(0, 100);
  if (tag === 'IMG' || tag === 'INPUT') {
    var alt = el.getAttribute && el.getAttribute('alt');
    if (alt && alt.trim()) return alt.trim().slice(0, 100);
  }
  if (tag === 'INPUT' || tag === 'BUTTON') {
    var t = String(el.type || '').toLowerCase();
    if ((t === 'submit' || t === 'button' || t === 'reset') && el.value) {
      return String(el.value).trim().slice(0, 100);
    }
  }
  if (el.labels && el.labels.length) {
    var lt = textOf(el.labels[0]);
    if (lt) return lt.slice(0, 100);
  }
  var ph = el.getAttribute && el.getAttribute('placeholder');
  var tx = textOf(el);
  if (!tx && ph && ph.trim()) return ph.trim().slice(0, 100);
  if (tx) return tx.slice(0, 100);
  var title = el.getAttribute && el.getAttribute('title');
  if (title && title.trim()) return title.trim().slice(0, 100);
  if (el.id) return '#' + el.id.slice(0, 60);
  return '';
}

/* Same-origin links shown as paths to save tokens; others absolute, capped. */
function shortHref(href) {
  var h = String(href);
  if (/^javascript:/i.test(h)) return '';
  try {
    var u = new URL(h, location.href);
    if (u.origin === location.origin) h = u.pathname + u.search + u.hash;
  } catch (e) {}
  return h.length > 120 ? h.slice(0, 117) + '...' : h;
}

/* --------------------------------------------------------------- snapshot */

function buildSnapshot(compact, maxChars) {
  generation += 1;
  refMap = new Map();
  elToRef = new WeakMap();
  var genId = 'g' + generation + '-' + Date.now().toString(36);
  lastGeneration = genId;

  var nodes = [];
  var lines = [];
  var ref = 0;

  var root = document.body || document.documentElement;
  if (!root) {
    return { generation: genId, url: location.href, title: document.title || '', truncated: false, nodes: [], text: '' };
  }

  // Walk light DOM plus open shadow roots (web components hide most of
  // their UI there, e.g. YouTube, GitHub, Reddit).
  var stack = [root];
  while (stack.length) {
  var walker = document.createTreeWalker(stack.pop(), NodeFilter.SHOW_ELEMENT, null);
  var el = walker.currentNode;
  while (el) {
    var tag = el.tagName;
    if (el.shadowRoot) stack.push(el.shadowRoot);
    if (tag && !SKIP_TAGS[tag]) {
      var interesting = isInteresting(el);
      var include = interesting || (!compact && hasDirectText(el));
      if (include && visible(el)) {
        var role = tagRole(el, compact);
        if (role) {
          ref += 1;
          var name = computeName(el, tag);
          var node = { ref: ref, role: role, name: name };
          var flags = [];
          if (el.disabled) { node.disabled = true; flags.push('[disabled]'); }
          if (tag === 'INPUT') {
            var it = String(el.type || 'text').toLowerCase();
            if ((it === 'checkbox' || it === 'radio')) {
              node.checked = !!el.checked;
              flags.push(el.checked ? '[checked]' : '[unchecked]');
            }
            if (el.readOnly) { node.readonly = true; flags.push('[readonly]'); }
            if (typeof el.value === 'string' && el.value && it !== 'checkbox' && it !== 'radio' &&
                it !== 'submit' && it !== 'button' && it !== 'reset' && it !== 'password') {
              node.value = String(el.value).slice(0, 200);
            }
          }
          if (tag === 'TEXTAREA' && el.value) node.value = String(el.value).slice(0, 200);
          if (tag === 'SELECT') {
            try {
              var sel = [];
              for (var oi = 0; oi < el.options.length; oi++) {
                if (el.options[oi].selected) sel.push(el.options[oi].text);
              }
              if (sel.length) node.value = sel.join(', ').slice(0, 200);
            } catch (e) {}
          }
          if (el.isContentEditable && el.textContent) {
            node.value = String(el.textContent).trim().slice(0, 200);
          }
          var exp = el.getAttribute && el.getAttribute('aria-expanded');
          if (exp === 'true' || exp === 'false') {
            node.expanded = exp === 'true';
            flags.push(exp === 'true' ? '[expanded]' : '[collapsed]');
          }
          var sel2 = el.getAttribute && el.getAttribute('aria-selected');
          if (sel2 === 'true') { node.selected = true; flags.push('[selected]'); }
          var hm = HEADING_RE.exec(tag);
          if (hm) node.level = Number(hm[1]);
          if (tag === 'A' && el.href) node.href = shortHref(el.href);
          nodes.push(node);
          refMap.set(ref, el);
          try { elToRef.set(el, ref); } catch (e) {}
          var line = '[ref=' + ref + '] ' + role + (name ? ' ' + JSON.stringify(name) : '');
          if (node.value !== undefined && role !== 'heading' && role !== 'link' && role !== 'button') {
            line += ' ' + JSON.stringify(String(node.value).slice(0, 80));
          }
          if (node.level) line += ' [h' + node.level + ']';
          if (node.href) line += ' -> ' + node.href;
          if (flags.length) line += ' ' + flags.join(' ');
          lines.push(line);
        }
      }
    }
    el = walker.nextNode();
  }
  }

  var text = lines.join('\n');
  var truncated = false;
  if (text.length > maxChars) {
    truncated = true;
    // Trim whole lines from the end so refs stay valid for the kept prefix.
    var kept = [];
    var len = 0;
    for (var i = 0; i < lines.length; i++) {
      var add = lines[i].length + (kept.length ? 1 : 0);
      if (len + add > maxChars) break;
      kept.push(lines[i]);
      len += add;
    }
    text = kept.join('\n');
    nodes = nodes.slice(0, kept.length);
  }

  return {
    generation: genId,
    url: location.href,
    title: document.title || '',
    truncated: truncated,
    nodes: nodes,
    text: text
  };
}

/* ------------------------------------------------------------------ targets */

function checkGeneration(msg) {
  if (msg.generation !== undefined && msg.generation !== null && msg.generation !== '' &&
      msg.generation !== lastGeneration) {
    throw be('REF_STALE', 'Snapshot generation mismatch (refs are stale, re-take snapshot)');
  }
}

function resolveTarget(msg) {
  checkGeneration(msg);
  if (msg.ref !== undefined && msg.ref !== null && msg.ref !== '') {
    var el = refMap.get(Number(msg.ref));
    if (!el || !el.isConnected) {
      throw be('REF_NOT_FOUND', 'Unknown or detached ref: ' + msg.ref);
    }
    return el;
  }
  if (msg.selector) {
    var found;
    try { found = document.querySelector(String(msg.selector)); } catch (e) {
      throw be('INVALID_PARAMS', 'Bad selector: ' + msg.selector);
    }
    if (!found) throw be('REF_NOT_FOUND', 'No element matches selector: ' + msg.selector);
    return found;
  }
  return null;
}

function mustResolve(msg) {
  var el = resolveTarget(msg);
  if (!el) throw be('INVALID_PARAMS', 'act requires ref or selector');
  return el;
}

function mouseEvent(type, opts) {
  var init = { bubbles: true, cancelable: true, composed: true, view: window };
  if (opts) for (var k in opts) init[k] = opts[k];
  var ev;
  try { ev = new MouseEvent(type, init); }
  catch (e) {
    ev = document.createEvent('MouseEvents');
    ev.initMouseEvent(type, true, true, window, 1, 0, 0, 0, 0,
      !!(opts && opts.ctrlKey), !!(opts && opts.altKey), !!(opts && opts.shiftKey),
      !!(opts && opts.metaKey), (opts && opts.button) || 0, null);
  }
  return ev;
}

/* ------------------------------------------------------------------ actions */

function doClick(msg) {
  var el = mustResolve(msg);
  var button = (msg.button || 'left').toLowerCase();
  var btnCode = button === 'middle' ? 1 : (button === 'right' ? 2 : 0);
  try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch (e) {}
  var rect = el.getBoundingClientRect();
  var pos = { button: btnCode, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
  var ptr = function (type) {
    try { el.dispatchEvent(new PointerEvent(type, Object.assign({ bubbles: true, cancelable: true, composed: true, pointerType: 'mouse' }, pos))); } catch (e) {}
  };
  ptr('pointerover');
  el.dispatchEvent(mouseEvent('mouseover', pos));
  ptr('pointerdown');
  el.dispatchEvent(mouseEvent('mousedown', pos));
  try { el.focus({ preventScroll: true }); } catch (e) { try { el.focus(); } catch (e2) {} }
  ptr('pointerup');
  el.dispatchEvent(mouseEvent('mouseup', pos));
  if (btnCode === 2) {
    el.dispatchEvent(mouseEvent('contextmenu', pos));
  } else if (btnCode === 1) {
    el.dispatchEvent(mouseEvent('auxclick', pos));
  } else if (typeof el.click === 'function') {
    // Exactly one click: el.click() fires the click event AND runs default
    // actions (follow link, toggle checkbox, submit). Dispatching a synthetic
    // 'click' as well would double-toggle checkboxes and double-submit forms.
    el.click();
  } else {
    el.dispatchEvent(mouseEvent('click', pos));
  }
  var r = elToRef.get(el);
  return { clicked: true, ref: (r !== undefined ? r : (msg.ref !== undefined ? Number(msg.ref) : undefined)) };
}

function setValue(el, text) {
  var tag = el.tagName;
  var type = tag === 'INPUT' ? String(el.type || 'text').toLowerCase() : '';
  // Checkbox/radio: typing makes no sense — toggle via click().
  if (type === 'checkbox' || type === 'radio') {
    try { el.focus(); } catch (e) {}
    if (typeof el.click === 'function') { try { el.click(); } catch (e) {} }
    return;
  }
  if (el.isContentEditable) {
    try { el.focus(); } catch (e) {}
    try {
      var sel = window.getSelection();
      if (sel) {
        var range = document.createRange();
        range.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    } catch (e) {}
    var inserted = false;
    try {
      if (document.queryCommandSupported && document.queryCommandSupported('insertText')) {
        inserted = document.execCommand('insertText', false, text);
      } else if (typeof document.execCommand === 'function') {
        inserted = document.execCommand('insertText', false, text);
      }
    } catch (e) { inserted = false; }
    if (!inserted) {
      el.textContent = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }
  if (tag === 'INPUT' || tag === 'TEXTAREA') {
    try { el.focus(); } catch (e) {}
    // Native value setter trick so React/Vue controlled inputs notice the change.
    try {
      var proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      var desc = proto && Object.getOwnPropertyDescriptor(proto, 'value');
      var setter = desc && desc.set;
      if (setter) setter.call(el, text);
      else el.value = text;
    } catch (e) { el.value = text; }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }
  // Fallback: focus and notify listeners.
  try { el.focus(); } catch (e) {}
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function pressEnter(el) {
  ['keydown', 'keypress', 'keyup'].forEach(function (type) {
    var ev;
    try {
      ev = new KeyboardEvent(type, {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
        bubbles: true, cancelable: true, composed: true
      });
    } catch (e) { return; }
    el.dispatchEvent(ev);
  });
}

function doType(msg) {
  var el = mustResolve(msg);
  var text = (msg.text === undefined || msg.text === null) ? '' : String(msg.text);
  setValue(el, text);
  if (msg.submit) {
    if (el.form) {
      if (typeof el.form.requestSubmit === 'function') {
        try { el.form.requestSubmit(); } catch (e) {
          try {
            if (typeof el.form.submit === 'function') el.form.submit();
            else pressEnter(el);
          } catch (e2) { pressEnter(el); }
        }
      } else if (typeof el.form.submit === 'function') {
        try { el.form.submit(); } catch (e) { pressEnter(el); }
      } else {
        pressEnter(el);
      }
    } else {
      pressEnter(el);
    }
  }
  var r = elToRef.get(el);
  return { typed: true, ref: (r !== undefined ? r : undefined) };
}

function doFillForm(msg) {
  var fields = msg.fields || [];
  var count = 0;
  fields.forEach(function (f) {
    var el = resolveTarget({ ref: f.ref, selector: f.selector, generation: msg.generation });
    if (!el) return;
    setValue(el, (f.value === undefined || f.value === null) ? '' : String(f.value));
    count += 1;
  });
  if (msg.submit) {
    var active = document.activeElement;
    var form = active && active.form;
    if (!form) {
      var first = fields.length ? resolveTarget({ ref: fields[0].ref, selector: fields[0].selector }) : null;
      form = first && first.form;
    }
    if (form) {
      if (typeof form.requestSubmit === 'function') { try { form.requestSubmit(); } catch (e) {} }
      else if (typeof form.submit === 'function') { try { form.submit(); } catch (e) {} }
    } else if (active) {
      pressEnter(active);
    }
  }
  return { filled: count };
}

function doSelect(msg) {
  var el = mustResolve(msg);
  var values = (msg.values || []).map(function (v) { return String(v).trim().toLowerCase(); });
  if (el.tagName !== 'SELECT') throw be('INVALID_PARAMS', 'act.select target is not a <select>');
  var matched = [];
  for (var i = 0; i < el.options.length; i++) {
    var o = el.options[i];
    var val = String(o.value !== undefined && o.value !== null ? o.value : '').trim().toLowerCase();
    var label = String(o.text !== undefined && o.text !== null ? o.text : '').trim().toLowerCase();
    var hit = values.indexOf(val) >= 0 || values.indexOf(label) >= 0;
    if (el.multiple) {
      o.selected = hit;
      if (hit) matched.push(o.value);
    } else if (hit && !matched.length) {
      el.selectedIndex = i;
      matched.push(o.value);
    }
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { selected: matched, count: matched.length };
}

function doHover(msg) {
  var el = mustResolve(msg);
  try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) {}
  el.dispatchEvent(mouseEvent('mouseover', {}));
  try { el.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })); } catch (e) {}
  el.dispatchEvent(mouseEvent('mouseenter', {}));
  return { hovered: true };
}

function doScroll(msg) {
  if (msg.to === 'top') { window.scrollTo(0, 0); return { scrolled: true, to: 'top' }; }
  if (msg.to === 'bottom') { window.scrollTo(0, document.documentElement.scrollHeight); return { scrolled: true, to: 'bottom' }; }
  var target = null;
  if (msg.ref !== undefined && msg.ref !== null && msg.ref !== '' || msg.selector) {
    target = resolveTarget(msg);
  }
  if (target) {
    try { target.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
    return { scrolled: true };
  }
  var dir = String(msg.direction || 'down').toLowerCase();
  var px = msg.pixels !== undefined ? Number(msg.pixels) : 500;
  if (!Number.isFinite(px)) px = 500;
  var dx = 0, dy = 0;
  if (dir === 'up') dy = -px;
  else if (dir === 'down') dy = px;
  else if (dir === 'left') dx = -px;
  else if (dir === 'right') dx = px;
  else if (dir === 'top') { window.scrollTo(window.scrollX, 0); return { scrolled: true }; }
  else if (dir === 'bottom') { window.scrollTo(window.scrollX, document.documentElement.scrollHeight); return { scrolled: true }; }
  window.scrollBy(dx, dy);
  return { scrolled: true, x: window.scrollX, y: window.scrollY };
}

function doKey(msg) {
  var key = String(msg.key);
  var mods = msg.modifiers || [];
  if (!Array.isArray(mods)) mods = [mods];
  function has(m) { return mods.indexOf(m) >= 0; }
  var ctrlKey = has('ctrl') || has('Control') || has('ctrlKey');
  var shiftKey = has('shift') || has('Shift') || has('shiftKey');
  var altKey = has('alt') || has('Alt') || has('altKey');
  var metaKey = has('meta') || has('Meta') || has('metaKey') || has('cmd');
  var target = document.activeElement || document.body;
  ['keydown', 'keypress', 'keyup'].forEach(function (type) {
    var ev;
    try {
      ev = new KeyboardEvent(type, {
        key: key,
        bubbles: true, cancelable: true, composed: true,
        ctrlKey: ctrlKey, shiftKey: shiftKey, altKey: altKey, metaKey: metaKey
      });
    } catch (e) { return; }
    target.dispatchEvent(ev);
  });
  return { pressed: key };
}

function sleep(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }

async function doWait(msg) {
  var timeoutMs = msg.timeoutMs !== undefined ? Number(msg.timeoutMs) : 10000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) timeoutMs = 10000;
  timeoutMs = Math.min(timeoutMs, 60000);
  var start = Date.now();
  var wantText = (msg.text !== undefined && msg.text !== null && String(msg.text) !== '') ? String(msg.text).toLowerCase() : null;
  var wantSel = msg.selector ? String(msg.selector) : null;
  if (!wantText && !wantSel) {
    await sleep(Math.min(timeoutMs, 1000));
    return { found: true, elapsedMs: Date.now() - start };
  }
  for (;;) {
    var ok = false;
    try {
      if (wantSel && document.querySelector(wantSel)) ok = true;
      if (!ok && wantText && document.body && (document.body.innerText || '').toLowerCase().indexOf(wantText) >= 0) ok = true;
    } catch (e) {}
    if (ok) return { found: true, elapsedMs: Date.now() - start };
    if (Date.now() - start >= timeoutMs) return { found: false, elapsedMs: Date.now() - start };
    await sleep(100);
  }
}

function doFind(msg) {
  var q = String(msg.query).toLowerCase();
  var matches = [];
  var walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT, null);
  var n = walker.currentNode;
  while (n && matches.length < 20) {
    var val = n.nodeValue || '';
    var idx = val.toLowerCase().indexOf(q);
    if (idx >= 0 && val.trim()) {
      var start = Math.max(0, idx - 30);
      var snippet = val.slice(start, idx + q.length + 30).replace(/\s+/g, ' ').trim();
      var parent = n.parentElement;
      var ref;
      if (parent) {
        var r = elToRef.get(parent);
        if (r !== undefined) ref = r;
      }
      var m = { snippet: snippet };
      if (ref !== undefined) m.ref = ref;
      matches.push(m);
    }
    n = walker.nextNode();
  }
  return { matches: matches, count: matches.length };
}

/* -------------------------------------------------------------- AI cursor */

function shortName(el) {
  var n = '';
  try { n = computeName(el, String(el.tagName || '').toLowerCase()) || ''; } catch (e) {}
  n = String(n).replace(/\s+/g, ' ').trim();
  return n.length > 40 ? n.slice(0, 39) + '…' : n;
}

function quoted(s) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  if (s.length > 40) s = s.slice(0, 39) + '…';
  return s ? ' “' + s + '”' : '';
}

function ensureVisible(el) {
  var r = el.getBoundingClientRect();
  if (r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth) {
    try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch (e) {}
  }
}

/* Before an action: glide the cursor to its target and say what's happening.
 * msg.cursor is set by the background only when the cursor is enabled;
 * msg.cursor.note is the model's own words, if it gave any. */
async function cursorBefore(msg) {
  var C = window.__fxmcpCursor;
  if (!msg.cursor || !C) return;
  var note = msg.cursor.note ? String(msg.cursor.note) : '';
  var el = null;
  try {
    switch (msg.kind) {
      case 'act-click': case 'act-type': case 'act-select': case 'act-hover':
        el = resolveTarget(msg);
        break;
      case 'act-fillForm': {
        var f = (msg.fields || [])[0];
        if (f) el = resolveTarget({ ref: f.ref, selector: f.selector, generation: msg.generation });
        break;
      }
      case 'act-scroll':
        if ((msg.ref !== undefined && msg.ref !== null && msg.ref !== '') || msg.selector) el = resolveTarget(msg);
        break;
    }
  } catch (e) { el = null; } // a bad target is reported by the action itself
  var name = el ? shortName(el) : '';
  var dflt;
  switch (msg.kind) {
    case 'act-click': dflt = 'Clicking' + quoted(name); break;
    case 'act-type':
      dflt = el && String(el.type).toLowerCase() === 'password' ? 'Typing a password' : 'Typing' + quoted(msg.text);
      break;
    case 'act-fillForm': dflt = 'Filling in a form'; break;
    case 'act-select': dflt = 'Choosing' + quoted((msg.values || []).join(', ')); break;
    case 'act-hover': dflt = 'Hovering over' + quoted(name); break;
    case 'act-scroll':
      dflt = el ? 'Scrolling to' + quoted(name) : msg.to ? 'Scrolling to the ' + msg.to : 'Scrolling ' + String(msg.direction || 'down');
      break;
    case 'act-key': dflt = 'Pressing ' + String(msg.key); break;
    case 'act-wait': dflt = 'Waiting for' + (quoted(msg.text || msg.selector) || ' the page'); break;
    case 'act-find': dflt = 'Looking for' + quoted(msg.query); break;
    default: dflt = 'Reading the page';
  }
  if (el) {
    ensureVisible(el);
    await C.moveTo(el, note || dflt);
  } else {
    C.say(note || dflt);
  }
}

function cursorAfter(msg) {
  var C = window.__fxmcpCursor;
  if (msg.cursor && C && msg.kind === 'act-click') C.click();
}

function cursorCommand(msg) {
  var C = window.__fxmcpCursor;
  if (!C) return { shown: false };
  switch (msg.op) {
    case 'say': C.say(msg.note); return { shown: true };
    case 'conceal':
      // Give the compositor a moment to drop the overlay before the screenshot.
      if (!C.conceal()) return { ok: true };
      return new Promise(function (r) { setTimeout(function () { r({ ok: true }); }, 60); });
    case 'reveal': C.reveal(); return { ok: true };
    case 'hide': C.hide(); return { ok: true };
    default: throw be('INVALID_PARAMS', 'Unknown cursor op: ' + msg.op);
  }
}

/* ------------------------------------------------------------------ dispatch */

async function handleMessage(msg) {
  if (!msg || typeof msg.kind !== 'string') return undefined; // not ours
  if (msg.kind === 'cursor') return cursorCommand(msg);
  if (msg.cursor) await cursorBefore(msg);
  var result = await dispatch(msg);
  if (msg.cursor) cursorAfter(msg);
  return result;
}

async function dispatch(msg) {
  switch (msg.kind) {
    case 'ax-snapshot': {
      var maxChars = (msg.maxChars !== undefined && Number.isFinite(Number(msg.maxChars))) ? Number(msg.maxChars) : 50000;
      return buildSnapshot(msg.compact !== false, maxChars);
    }
    case 'page-text': {
      var mc = (msg.maxChars !== undefined && Number.isFinite(Number(msg.maxChars))) ? Number(msg.maxChars) : 50000;
      var t = '';
      try { t = (document.body && document.body.innerText) || document.documentElement.textContent || ''; }
      catch (e) { t = ''; }
      t = String(t);
      var trunc = t.length > mc;
      return { text: trunc ? t.slice(0, mc) : t, truncated: trunc, url: location.href, title: document.title || '' };
    }
    case 'page-html': {
      var mc2 = (msg.maxChars !== undefined && Number.isFinite(Number(msg.maxChars))) ? Number(msg.maxChars) : 50000;
      var html;
      if (msg.selector) {
        var sel;
        try { sel = document.querySelector(String(msg.selector)); } catch (e) {
          throw be('INVALID_PARAMS', 'Bad selector: ' + msg.selector);
        }
        if (!sel) throw be('REF_NOT_FOUND', 'No element matches selector: ' + msg.selector);
        html = sel.outerHTML;
      } else {
        html = document.documentElement ? document.documentElement.outerHTML : '';
      }
      html = String(html).replace(/<fxmcp-cursor\b[^>]*><\/fxmcp-cursor>/g, ''); // our overlay isn't page content
      html = String(html);
      var trunc2 = html.length > mc2;
      return { html: trunc2 ? html.slice(0, mc2) : html, truncated: trunc2, url: location.href, title: document.title || '' };
    }
    case 'act-click': return doClick(msg);
    case 'act-type': return doType(msg);
    case 'act-fillForm': return doFillForm(msg);
    case 'act-select': return doSelect(msg);
    case 'act-hover': return doHover(msg);
    case 'act-scroll': return doScroll(msg);
    case 'act-key': return doKey(msg);
    case 'act-wait': return await doWait(msg);
    case 'act-find': return doFind(msg);
    default:
      throw be('UNKNOWN_METHOD', 'Unknown content kind: ' + msg.kind);
  }
}

if (B.runtime && B.runtime.onMessage) {
  B.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    // Sync foreign-message guard: handleMessage is async, so its
    // `return undefined` would arrive as Promise<undefined> and get
    // wrapped in an envelope. Check here so non-ours messages fall
    // through to other listeners untouched.
    if (!msg || typeof msg.kind !== 'string') return undefined; // not ours — let other listeners run
    var p;
    try { p = handleMessage(msg); } catch (e) {
      if (typeof sendResponse === 'function') {
        try { sendResponse({ __fxmcp: true, ok: false, error: errToObj(e) }); } catch (e2) {}
        return true;
      }
      return Promise.reject(e);
    }
    if (p === undefined) return undefined; // (unreachable after guard — kept for safety)
    var done = function (result) {
      var env = { __fxmcp: true, ok: true, result: (result === undefined ? null : result) };
      if (typeof sendResponse === 'function') { try { sendResponse(env); } catch (e) {} }
      return env;
    };
    var fail = function (err) {
      var env = { __fxmcp: true, ok: false, error: errToObj(err) };
      if (typeof sendResponse === 'function') { try { sendResponse(env); } catch (e) {} }
      return env;
    };
    if (p && typeof p.then === 'function') {
      // Serve both worlds: callback (chrome) and promise (Firefox `browser`).
      if (typeof sendResponse === 'function') {
        p.then(done, fail);
        return true;
      }
      return p.then(function (r) { return { __fxmcp: true, ok: true, result: r }; },
                     function (e) { return { __fxmcp: true, ok: false, error: errToObj(e) }; });
    }
    return done(p);
  });
}

})();
