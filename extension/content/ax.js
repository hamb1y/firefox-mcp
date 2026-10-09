/* WebMCP Controller — content script (isolated world).
 * Plain classic script (no modules). Idempotent: safe to re-inject.
 * Owns AX `ref` numbering. A ref names one element for the life of the
 * document and is never reused; each document starts numbering at a random
 * base so a ref from an earlier page can't silently hit a different element.
 */
(function () {
'use strict';

if (window.__fxmcp) return;
window.__fxmcp = true;

var B = (typeof browser !== 'undefined') ? browser : chrome;

var HAS_WEAKREF = typeof WeakRef === 'function';
var docId = Math.random().toString(36).slice(2, 8);
var generation = 0;
var generations = new Set(); // snapshot generation ids issued for this document
var nextRef = 1000 + Math.floor(Math.random() * 89000);
var refMap = new Map();      // ref number -> WeakRef<Element>
var elToRef = new WeakMap(); // Element -> ref number

/* The element's ref, assigning the next unused number the first time it's seen. */
function refFor(el) {
  var r = elToRef.get(el);
  if (r === undefined) {
    r = ++nextRef;
    elToRef.set(el, r);
    refMap.set(r, HAS_WEAKREF ? new WeakRef(el) : el);
  }
  return r;
}

function elForRef(r) {
  var h = refMap.get(r);
  if (!h) return null;
  return HAS_WEAKREF && h instanceof WeakRef ? h.deref() || null : h;
}

/* Forget refs whose elements were garbage-collected. */
function pruneRefs() {
  if (!HAS_WEAKREF || refMap.size < 5000) return;
  refMap.forEach(function (h, r) { if (!h.deref()) refMap.delete(r); });
}

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

/* The parent in the flat tree: shadow roots hand over to their host. */
function flatParent(n) {
  if (n.parentNode && n.parentNode.nodeType === 11 && n.parentNode.host) return n.parentNode.host;
  return n.parentElement || (n.parentNode && n.parentNode.host) || null;
}

/* Hidden from assistive tech by an ancestor (aria-hidden, inert)? */
function axHidden(el) {
  for (var n = el; n; n = flatParent(n)) {
    if (n.getAttribute && (n.getAttribute('aria-hidden') === 'true' || n.hasAttribute('inert'))) return true;
  }
  return false;
}

function visible(el) {
  if (!(el instanceof Element)) return false;
  if (el.hasAttribute('hidden')) return false;
  if (axHidden(el)) return false;
  return rendered(el, 0);
}

function rendered(el, depth) {
  var cs;
  try { cs = window.getComputedStyle(el); } catch (e) { return true; }
  if (!cs || cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
  // display:contents has no box of its own; it shows if any child does.
  if (cs.display === 'contents') {
    if (depth > 8) return true;
    for (var c = el.firstElementChild; c; c = c.nextElementSibling) {
      if (rendered(c, depth + 1)) return true;
    }
    for (var t = el.firstChild; t; t = t.nextSibling) {
      if (t.nodeType === 3 && t.nodeValue && t.nodeValue.trim()) return true;
    }
    return false;
  }
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
      // ids resolve within the element's own (shadow) tree
      var scope = el.getRootNode ? el.getRootNode() : document;
      var lab = (scope && scope.getElementById ? scope : document).getElementById(id);
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
  pruneRefs();
  var genId = 'g' + generation + '-' + docId + '-' + Date.now().toString(36);
  generations.add(genId);

  var nodes = [];
  var lines = [];
  var len = 0;
  var truncated = false;

  var root = document.body || document.documentElement;
  if (!root) {
    return { generation: genId, url: location.href, title: document.title || '', truncated: false, nodes: [], text: '' };
  }

  // Walk light DOM plus open shadow roots (web components hide most of
  // their UI there, e.g. YouTube, GitHub, Reddit). Stops once the text budget
  // is spent, so huge pages don't cost a full walk.
  var stack = [root];
  outer:
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
          var name = computeName(el, tag);
          var node = { ref: 0, role: role, name: name };
          var flags = [];
          if (isDisabled(el)) { node.disabled = true; flags.push('[disabled]'); }
          else if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') { node.disabled = true; flags.push('[disabled]'); }
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
          if (tag === 'TEXTAREA' && el.readOnly) { node.readonly = true; flags.push('[readonly]'); }
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
          var ref = refFor(el);
          node.ref = ref;
          var line = '[ref=' + ref + '] ' + role + (name ? ' ' + JSON.stringify(name) : '');
          if (node.value !== undefined && role !== 'heading' && role !== 'link' && role !== 'button') {
            line += ' ' + JSON.stringify(String(node.value).slice(0, 80));
          }
          if (node.level) line += ' [h' + node.level + ']';
          if (node.href) line += ' -> ' + node.href;
          if (flags.length) line += ' ' + flags.join(' ');
          var add = line.length + (lines.length ? 1 : 0);
          if (len + add > maxChars) { truncated = true; break outer; }
          len += add;
          nodes.push(node);
          lines.push(line);
        }
      }
    }
    el = walker.nextNode();
  }
  }

  return {
    generation: genId,
    url: location.href,
    title: document.title || '',
    truncated: truncated,
    nodes: nodes,
    text: lines.join('\n')
  };
}

/* ------------------------------------------------------------------ targets */

/* Refs are stable for the life of the document, so any generation issued here
   is fine. An unknown one means the snapshot came from another page load. */
function checkGeneration(msg) {
  if (msg.generation !== undefined && msg.generation !== null && msg.generation !== '' &&
      !generations.has(String(msg.generation))) {
    throw be('REF_STALE', 'That snapshot is from a different page load (the page navigated or reloaded). Take a new snapshot_ax.');
  }
}

function resolveTarget(msg) {
  checkGeneration(msg);
  if (msg.ref !== undefined && msg.ref !== null && msg.ref !== '') {
    var el = elForRef(Number(msg.ref));
    if (!el) {
      throw be('REF_NOT_FOUND', 'Unknown ref ' + msg.ref + ' on this page (it may have navigated). Take a new snapshot_ax.');
    }
    if (!el.isConnected) {
      throw be('REF_STALE', 'ref ' + msg.ref + ' was removed from the page. Take a new snapshot_ax.');
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

function isDisabled(el) {
  try { if (el.matches(':disabled')) return true; } catch (e) {}
  return false;
}

function ariaDisabled(el) {
  for (var n = el; n && n.getAttribute; n = flatParent(n)) {
    if (n.getAttribute('aria-disabled') === 'true') return true;
  }
  return false;
}

function assertEnabled(el, what) {
  if (isDisabled(el)) throw be('ELEMENT_DISABLED', describe(el) + ' is disabled; ' + what + ' would do nothing.');
}

/* Is `anc` an ancestor of `el` in the flat tree (crossing shadow roots)? */
function flatContains(anc, el) {
  for (var n = el; n; n = flatParent(n)) if (n === anc) return true;
  return false;
}

/* In an inert subtree, or outside an open modal dialog: no user can reach it. */
function isInert(el) {
  for (var n = el; n; n = flatParent(n)) {
    if (n.hasAttribute && n.hasAttribute('inert')) return true;
  }
  var modal = null;
  try { modal = document.querySelector('dialog:modal'); } catch (e) {}
  return !!(modal && !flatContains(modal, el));
}

function assertActionable(el, what) {
  if (!el.isConnected) throw be('REF_STALE', describe(el) + ' was removed from the page. Take a new snapshot_ax.');
  assertEnabled(el, what);
  if (isInert(el)) {
    throw be('NOT_INTERACTABLE', describe(el) + ' is inert (behind a modal dialog or in an inert region), so a user couldn\'t reach it; ' + what + ' was not done.');
  }
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

function refOf(el, msg) {
  var r = elToRef.get(el);
  if (r !== undefined) return r;
  return msg && msg.ref !== undefined && msg.ref !== null && msg.ref !== '' ? Number(msg.ref) : undefined;
}

function doClick(msg, target) {
  var el = target || mustResolve(msg);
  assertActionable(el, 'clicking it');
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
  // The page's pointer handlers ran: it may have removed or disabled the element.
  if (!el.isConnected || isDisabled(el)) {
    return { clicked: false, ref: refOf(el, msg), note: 'The page ' + (el.isConnected ? 'disabled' : 'removed') + ' the element while it was being pressed, so the click didn\'t complete.' };
  }
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
  var out = { clicked: true, ref: refOf(el, msg) };
  if (ariaDisabled(el)) out.warning = 'The element is marked aria-disabled, so the page may have ignored the click.';
  return out;
}

/* ------------------------------------------------------------ field values */

var NON_TEXT_INPUTS = { button: 1, submit: 1, reset: 1, image: 1, file: 1, hidden: 1 };

function inputType(el) {
  return el.tagName === 'INPUT' ? String(el.type || 'text').toLowerCase() : '';
}

function isTextField(el) {
  if (!el || !el.tagName) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === 'TEXTAREA') return true;
  if (el.tagName === 'INPUT') {
    var t = inputType(el);
    return !NON_TEXT_INPUTS[t] && t !== 'checkbox' && t !== 'radio' && t !== 'range' && t !== 'color';
  }
  return false;
}

/* The element that will actually take a value. A ref to a wrapper with exactly
   one field inside resolves to that field; anything else non-editable throws. */
function editableTarget(el) {
  var tag = el.tagName;
  var ok = el.isContentEditable || tag === 'TEXTAREA' || tag === 'SELECT' ||
    (tag === 'INPUT' && !NON_TEXT_INPUTS[inputType(el)]);
  if (!ok) {
    var inner = el.querySelectorAll ? el.querySelectorAll(
      'input:not([type=hidden]):not([type=button]):not([type=submit]):not([type=reset]):not([type=image]):not([type=file]),' +
      'textarea, select, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]') : [];
    if (inner.length === 1) el = inner[0];
    else {
      var what = tag === 'INPUT' ? 'a ' + inputType(el) + ' input' : describe(el);
      throw be('NOT_EDITABLE', describe(el) + ' is ' + (what === describe(el) ? 'not a text field' : what) +
        ', so it can\'t take a value' + (tag === 'BUTTON' || NON_TEXT_INPUTS[inputType(el)] ? ' (use act_click)' : '') + '.');
    }
  }
  if (isDisabled(el)) throw be('ELEMENT_DISABLED', describe(el) + ' is disabled.');
  if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.readOnly) {
    throw be('NOT_EDITABLE', describe(el) + ' is read-only.');
  }
  if (isInert(el)) throw be('NOT_INTERACTABLE', describe(el) + ' is inert (behind a modal dialog or in an inert region).');
  return el;
}

var TRUE_WORDS = { 'true': 1, on: 1, '1': 1, yes: 1, checked: 1, check: 1, y: 1 };
var FALSE_WORDS = { 'false': 1, off: 1, '0': 1, no: 1, unchecked: 1, uncheck: 1, n: 1, '': 1 };

function parseChecked(v) {
  var s = String(v).trim().toLowerCase();
  if (TRUE_WORDS[s]) return true;
  if (FALSE_WORDS[s]) return false;
  throw be('INVALID_PARAMS', 'A checkbox or radio takes true/false (or on/off, yes/no, checked/unchecked), not ' + JSON.stringify(String(v)) + '.');
}

/* Disabled itself or by its <optgroup>. */
function optionDisabled(o) {
  if (o.disabled) return true;
  var g = o.parentElement;
  return !!(g && g.tagName === 'OPTGROUP' && g.disabled);
}

/* Indices of the <option>s to select: exact value, then exact label, then the
   same ignoring case. Throws NO_MATCH listing what's available. */
function matchOptions(el, values) {
  if (!el.multiple && values.length > 1) {
    throw be('INVALID_PARAMS', describe(el) + ' allows only one option; got ' + values.length + '.');
  }
  var opts = el.options;
  var label = function (o) { return String(o.label || o.text || '').replace(/\s+/g, ' ').trim(); };
  var out = [];
  values.forEach(function (raw) {
    var v = String(raw);
    var tests = [
      function (o) { return o.value === v; },
      function (o) { return label(o) === v.trim(); },
      function (o) { return o.value.toLowerCase() === v.trim().toLowerCase(); },
      function (o) { return label(o).toLowerCase() === v.trim().toLowerCase(); }
    ];
    for (var t = 0; t < tests.length; t++) {
      for (var i = 0; i < opts.length; i++) {
        if (!optionDisabled(opts[i]) && tests[t](opts[i])) { out.push(i); return; }
      }
    }
    var avail = [];
    for (var j = 0; j < opts.length && avail.length < 30; j++) {
      var l = label(opts[j]);
      avail.push(JSON.stringify(opts[j].value) + (l && l !== opts[j].value ? ' (' + l + ')' : '') +
        (optionDisabled(opts[j]) ? ' [disabled]' : ''));
    }
    throw be('NO_MATCH', 'No option matches ' + JSON.stringify(v) + ' in ' + describe(el) + '. Options: ' +
      avail.join(', ') + (opts.length > 30 ? ', …' : '') + '.');
  });
  return out;
}

/* Throws if `value` can't be applied to `el`, without touching the page. */
function checkValue(el, value) {
  var t = inputType(el);
  if (t === 'checkbox' || t === 'radio') {
    var want = parseChecked(value);
    if (t === 'radio' && !want && el.checked) {
      throw be('NOT_SUPPORTED', describe(el) + ' is a selected radio button; select a different option in its group instead.');
    }
  } else if (el.tagName === 'SELECT') {
    matchOptions(el, el.multiple ? String(value).split(/\s*,\s*/) : [String(value)]);
  }
}

function fireInput(el, inputType, data) {
  var ev;
  try {
    ev = new InputEvent('input', { bubbles: true, composed: true, inputType: inputType || 'insertText', data: data === undefined ? null : data });
  } catch (e) { ev = new Event('input', { bubbles: true, composed: true }); }
  el.dispatchEvent(ev);
}

function fireChange(el) {
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function nativeSetValue(el, text) {
  try {
    var proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    var desc = proto && Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, text);
    else el.value = text;
  } catch (e) { el.value = text; }
}

function selectIndices(el, idx) {
  if (el.multiple) {
    for (var i = 0; i < el.options.length; i++) el.options[i].selected = idx.indexOf(i) >= 0;
  } else {
    el.selectedIndex = idx[0];
  }
  fireInput(el);
  fireChange(el);
}

/* Apply a value to an element already checked by editableTarget/checkValue.
   Returns a short note when the outcome isn't simply "value set". */
function setValue(el, text) {
  checkValue(el, text);
  var type = inputType(el);
  if (type === 'checkbox' || type === 'radio') {
    try { el.focus(); } catch (e) {}
    var want = parseChecked(text);
    // click() runs the page's handlers; only click when the state must change.
    if (el.checked !== want) el.click();
    if (el.checked !== want) throw be('NOT_SUPPORTED', 'The page kept ' + describe(el) + (el.checked ? ' checked' : ' unchecked') + '.');
    return;
  }
  if (el.tagName === 'SELECT') {
    try { el.focus(); } catch (e) {}
    selectIndices(el, matchOptions(el, el.multiple ? String(text).split(/\s*,\s*/) : [String(text)]));
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
      inserted = text === '' ? document.execCommand('delete', false) : document.execCommand('insertText', false, text);
    } catch (e) { inserted = false; }
    if (!inserted) {
      el.textContent = text;
      fireInput(el, 'insertText', text);
    }
    return;
  }
  try { el.focus(); } catch (e) {}
  // Native value setter so React/Vue controlled inputs notice the change.
  nativeSetValue(el, text);
  fireInput(el, 'insertText', text);
  fireChange(el);
}

/* ---------------------------------------------------------------- submit */

/* Dispatch a key down/press/up on el. Returns true if the page cancelled keydown or keypress. */
function keySequence(el, key, init) {
  var opts = Object.assign({ key: key, bubbles: true, cancelable: true, composed: true }, init || {});
  var down = new KeyboardEvent('keydown', opts);
  el.dispatchEvent(down);
  var handled = down.defaultPrevented;
  if (!handled && (key.length === 1 || key === 'Enter')) {
    var press = new KeyboardEvent('keypress', opts);
    el.dispatchEvent(press);
    handled = press.defaultPrevented;
  }
  el.dispatchEvent(new KeyboardEvent('keyup', opts));
  return handled;
}

function pressEnter(el) {
  return keySequence(el, 'Enter', { code: 'Enter', keyCode: 13, which: 13 });
}

/* The visible text of a field, to tell whether a submit consumed it. */
function fieldText(el) {
  if (el.isContentEditable) return (el.innerText || el.textContent || '').trim();
  return el.value !== undefined ? String(el.value).trim() : '';
}

function isEditableField(n) {
  return n.isContentEditable || n.tagName === 'TEXTAREA' || n.tagName === 'SELECT' ||
    (n.tagName === 'INPUT' && !NON_TEXT_INPUTS[inputType(n)]);
}

/* A form's default (first) submit button, like implicit submission uses. */
function formSubmitButton(form) {
  var els = form.elements;
  for (var i = 0; i < els.length; i++) {
    var b = els[i];
    if ((b.tagName === 'BUTTON' && (b.type || 'submit') === 'submit') ||
        (b.tagName === 'INPUT' && (b.type === 'submit' || b.type === 'image'))) return b;
  }
  return null;
}

var SEND_LABEL = /^(send|submit|post|reply|search|go|ask)\b|send (message|prompt)|submit/i;

var REGION_SEL = 'form, main, aside, nav, header, footer, section, article, dialog, [role="main"], [role="complementary"], ' +
  '[role="navigation"], [role="region"], [role="dialog"], [role="search"], [role="banner"], [role="contentinfo"]';

/* The nearest landmark/section/form/dialog around el, or null. */
function regionOf(el) {
  for (var n = flatParent(el); n; n = flatParent(n)) {
    try { if (n.matches(REGION_SEL)) return n; } catch (e) {}
  }
  return null;
}

function buttonLabel(b) {
  return (b.getAttribute('aria-label') || b.title || b.value || b.textContent || '').replace(/\s+/g, ' ').trim();
}

/* The Send-like button in the field's own composer (chat apps often have no
 * <form>). Climbs a few ancestors, never past the field's region or a level
 * holding another field, and ignores buttons that belong to some form.
 * Returns {button}, {ambiguous: [descriptions]} or null. */
function composerButton(el) {
  var region = regionOf(el);
  var p = el;
  for (var i = 0; i < 8; i++) {
    p = flatParent(p);
    if (!p || p === document.body || p === document.documentElement) break;
    var fields = p.querySelectorAll('input, textarea, select, [contenteditable=""], [contenteditable="true"]');
    var other = false;
    for (var f = 0; f < fields.length; f++) {
      var n = fields[f];
      if (n !== el && !el.contains(n) && !n.contains(el) && isEditableField(n) && visible(n)) { other = true; break; }
    }
    if (other) break;
    var found = [];
    var cands = p.querySelectorAll('button, [role="button"], input[type="submit"]');
    for (var j = 0; j < cands.length; j++) {
      var b = cands[j];
      if (b === el || !visible(b) || isInert(b)) continue;
      if (b.form || (b.closest && b.closest('form'))) continue;
      var tid = b.getAttribute('data-testid') || '';
      if (SEND_LABEL.test(buttonLabel(b)) || /send-button|submit-button/i.test(tid)) found.push(b);
    }
    if (found.length === 1) return { button: found[0] };
    if (found.length > 1) {
      return { ambiguous: found.slice(0, 5).map(function (b) { return describe(b) + quoted(buttonLabel(b)); }) };
    }
    if (p === region) break;
  }
  return null;
}

/* Apps often enable the button only after reacting to the input event. */
async function whenEnabled(b, msg) {
  for (var t = 0; t < 10 && (isDisabled(b) || ariaDisabled(b)); t++) {
    await sleep(100);
    checkCancel(msg);
  }
  return !isDisabled(b) && !ariaDisabled(b);
}

/* The first field that would block submission, like the browser checks it. */
function invalidField(form, btn) {
  if (form.noValidate || (btn && btn.formNoValidate)) return null;
  var els = form.elements;
  for (var i = 0; i < els.length; i++) {
    var f = els[i];
    if (f.willValidate && f.validity && !f.validity.valid) return f;
  }
  return null;
}

/* Click a submit button; any failure becomes a note (the text is already typed). */
function clickSubmit(btn) {
  try {
    var r = doClick({}, btn);
    if (r.clicked === false) return { submitted: false, note: r.note };
  } catch (e) {
    return { submitted: false, note: e.message };
  }
  return { submitted: 'button', via: describe(btn) };
}

/* An explicit submit button from msg.submitRef / msg.submitSelector, or null. */
function submitTarget(msg) {
  var hasRef = msg.submitRef !== undefined && msg.submitRef !== null && msg.submitRef !== '';
  if (!hasRef && !msg.submitSelector) return null;
  try {
    return mustResolve({ ref: hasRef ? msg.submitRef : undefined, selector: msg.submitSelector, generation: msg.generation });
  } catch (e) {
    throw be(e.code || 'INVALID_PARAMS', 'Submit target: ' + e.message + ' Nothing was typed.');
  }
}

/* Submit like a user would, using exactly one mechanism chosen up front, so
 * nothing is ever sent twice:
 *  - an explicit submit button (submitRef/submitSelector): click it;
 *  - in a form: click its submit button, or requestSubmit if it has none;
 *  - outside a form (chat composers): click the composer's own Send button,
 *    or press Enter once if there is none.
 * Returns {submitted, via?, note?}. */
async function submitField(el, msg, explicit) {
  msg = msg || {};
  checkCancel(msg);
  if (explicit) {
    if (!(await whenEnabled(explicit, msg))) {
      return { submitted: false, note: describe(explicit) + ' stayed disabled; the page may consider the input incomplete.' };
    }
    return clickSubmit(explicit);
  }
  var form = el.form || (el.closest && el.closest('form'));
  if (form) {
    var btn = formSubmitButton(form);
    if (btn && !(await whenEnabled(btn, msg))) {
      return { submitted: false, note: 'The form\'s submit button (' + describe(btn) + ') is disabled; the page may consider the form incomplete.' };
    }
    var bad = invalidField(form, btn);
    if (bad) {
      var badName = shortName(bad);
      return { submitted: false, note: describe(bad) + (badName && badName !== '#' + bad.id ? quoted(badName) : '') + ' is invalid' +
        (bad.validationMessage ? ' (' + bad.validationMessage + ')' : '') + ', so the form wasn\'t submitted.' };
    }
    checkCancel(msg);
    var fired = false;
    var onSubmit = function (e) { if (e.target === form) fired = true; };
    window.addEventListener('submit', onSubmit, true);
    form.addEventListener('submit', onSubmit, true); // forms in shadow roots
    var out;
    try {
      if (btn) out = clickSubmit(btn);
      else if (typeof form.requestSubmit === 'function') { form.requestSubmit(); out = { submitted: 'form' }; }
      else { form.submit(); return { submitted: 'form' }; }
    } finally {
      window.removeEventListener('submit', onSubmit, true);
      form.removeEventListener('submit', onSubmit, true);
    }
    if (out.submitted && !fired) {
      out.note = 'No submit event fired, so the page handled the click itself or ignored it. Check the page before retrying.';
    }
    return out;
  }
  var cb = composerButton(el);
  if (cb && cb.ambiguous) {
    return { submitted: false, note: 'Several Send-like buttons are next to this field: ' + cb.ambiguous.join(', ') +
      '. Pass submitRef (or submitSelector) to pick one.' };
  }
  if (cb) {
    if (!(await whenEnabled(cb.button, msg))) {
      return { submitted: false, note: describe(cb.button) + ' stayed disabled; the page may consider the input incomplete.' };
    }
    return clickSubmit(cb.button);
  }
  checkCancel(msg);
  var before = fieldText(el);
  var url = location.href;
  var handled = pressEnter(el);
  await sleep(300);
  if (handled || location.href !== url || !el.isConnected || fieldText(el) !== before) {
    return { submitted: 'enter' };
  }
  return {
    submitted: false,
    note: 'Pressed Enter once but saw no reaction (field and URL unchanged), and there is no form or Send button next to this field. ' +
      'Check the page with snapshot_ax before retrying, since it may still be sending; to use a button, pass submitRef.'
  };
}

async function doType(msg) {
  var el = editableTarget(mustResolve(msg));
  var text = (msg.text === undefined || msg.text === null) ? '' : String(msg.text);
  var explicit = submitTarget(msg);
  checkCancel(msg);
  setValue(el, text);
  var out = { typed: true, ref: refOf(el, msg) };
  if (isTextField(el) && inputType(el) !== 'password' && fieldText(el) !== text.trim()) {
    out.value = fieldText(el).slice(0, 200);
    out.note = 'The page changed the value after typing.';
  }
  if (msg.submit || explicit) Object.assign(out, await submitField(el, msg, explicit));
  return out;
}

async function doFillForm(msg) {
  var fields = msg.fields || [];
  if (!fields.length) throw be('INVALID_PARAMS', 'act.fillForm needs at least one field');
  // Resolve and check every field before changing anything.
  var targets = fields.map(function (f, i) {
    try {
      if ((f.ref === undefined || f.ref === null || f.ref === '') && !f.selector) {
        throw be('INVALID_PARAMS', 'needs a ref or selector');
      }
      var el = editableTarget(resolveTarget({ ref: f.ref, selector: f.selector, generation: msg.generation }));
      checkValue(el, f.value === undefined || f.value === null ? '' : String(f.value));
      return el;
    } catch (e) {
      throw be(e.code || 'INVALID_PARAMS', 'fields[' + i + ']: ' + e.message + ' Nothing was filled.');
    }
  });
  var explicit = submitTarget(msg);
  for (var i = 0; i < targets.length; i++) {
    try {
      checkCancel(msg);
      // Earlier writes can make the page re-render: find the field again.
      var f = fields[i];
      var v = f.value === undefined || f.value === null ? '' : String(f.value);
      var el = editableTarget(mustResolve({ ref: f.ref, selector: f.selector, generation: msg.generation }));
      checkValue(el, v);
      setValue(el, v);
      targets[i] = el;
    } catch (e) {
      throw be(e.code || 'INTERNAL', 'fields[' + i + ']: ' + e.message + ' Filled ' + i + ' of ' + targets.length +
        ' fields before this one; the rest were not changed.');
    }
  }
  var out = { filled: targets.length };
  if (msg.submit || explicit) Object.assign(out, await submitField(targets[targets.length - 1], msg, explicit));
  return out;
}

function doSelect(msg) {
  var el = mustResolve(msg);
  if (el.tagName !== 'SELECT') {
    throw be('INVALID_PARAMS', describe(el) + ' is not a <select>. For custom dropdowns, act_click to open it, then act_click the option.');
  }
  assertActionable(el, 'selecting');
  var idx = matchOptions(el, (msg.values || []).map(String));
  try { el.focus(); } catch (e) {}
  selectIndices(el, idx);
  return {
    selected: idx.map(function (i) { return el.options[i].value; }),
    labels: idx.map(function (i) { return String(el.options[i].text || '').trim(); })
  };
}

function doHover(msg) {
  var el = mustResolve(msg);
  try { el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' }); } catch (e) {}
  var rect = el.getBoundingClientRect();
  var pos = { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
  var ptr = function (type, bubbles) {
    try { el.dispatchEvent(new PointerEvent(type, Object.assign({ bubbles: bubbles, cancelable: bubbles, composed: true, pointerType: 'mouse' }, pos))); } catch (e) {}
  };
  ptr('pointerover', true);
  ptr('pointerenter', false);
  el.dispatchEvent(mouseEvent('mouseover', pos));
  el.dispatchEvent(mouseEvent('mouseenter', Object.assign({ bubbles: false, cancelable: false }, pos)));
  ptr('pointermove', true);
  el.dispatchEvent(mouseEvent('mousemove', pos));
  return {
    hovered: true,
    note: 'Sent pointer/mouse hover events, which open JavaScript-driven menus and tooltips. Pure CSS :hover styles can\'t be triggered from an extension; if nothing appeared, try act_click.'
  };
}

/* ---------------------------------------------------------------- scroll */

function scrollRoot() {
  return document.scrollingElement || document.documentElement;
}

function windowScrolls(vertical) {
  var r = scrollRoot();
  return vertical ? r.scrollHeight - r.clientHeight > 20 : r.scrollWidth - r.clientWidth > 20;
}

function doScroll(msg) {
  var dir0 = String(msg.direction || 'down').toLowerCase();
  if (msg.to === 'top' || msg.to === 'bottom') {
    var box0 = windowScrolls(true) ? null : mainScroller(true);
    var top = msg.to === 'top' ? 0 : (box0 || scrollRoot()).scrollHeight;
    if (box0) box0.scrollTo({ left: box0.scrollLeft, top: top, behavior: 'instant' });
    else window.scrollTo({ left: window.scrollX, top: top, behavior: 'instant' });
    var b0 = box0 || scrollRoot();
    return { scrolled: true, to: msg.to, container: box0 ? describe(box0) : undefined, atEnd: atEnd(b0, msg.to === 'top' ? -1 : 1, true) };
  }
  var target = null;
  if (msg.ref !== undefined && msg.ref !== null && msg.ref !== '' || msg.selector) {
    target = resolveTarget(msg);
  }
  if (target) {
    try { target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch (e) {}
    return { scrolled: true, ref: refOf(target, msg) };
  }
  var vertical = dir0 !== 'left' && dir0 !== 'right';
  // Default: most of a screen, so consecutive scrolls overlap a little.
  var px = msg.pixels !== undefined ? Number(msg.pixels) : Math.round((vertical ? window.innerHeight : window.innerWidth) * 0.8);
  if (!Number.isFinite(px) || px <= 0) px = 500;
  var sign = (dir0 === 'up' || dir0 === 'left') ? -1 : 1;
  return scrollBy(vertical ? 0 : sign * px, vertical ? sign * px : 0);
}

/* Scroll the window, or the page's main inner scroller when the window can't
   move. 'instant' so the position (and atEnd) is measured after the move. */
function scrollBy(dx, dy) {
  var vertical = dy !== 0;
  var sign = (dx || dy) < 0 ? -1 : 1;
  var sx = window.scrollX, sy = window.scrollY;
  window.scrollBy({ left: dx, top: dy, behavior: 'instant' });
  if (window.scrollX !== sx || window.scrollY !== sy) {
    return { scrolled: true, x: window.scrollX, y: window.scrollY, atEnd: atEnd(scrollRoot(), sign, vertical) };
  }
  // The window didn't move: apps like chat UIs scroll an inner container.
  var box = mainScroller(vertical);
  if (!box) return { scrolled: false, x: sx, y: sy, atEnd: true };
  var bx = box.scrollLeft, by = box.scrollTop;
  box.scrollBy({ left: dx, top: dy, behavior: 'instant' });
  return {
    scrolled: box.scrollLeft !== bx || box.scrollTop !== by,
    container: describe(box),
    x: box.scrollLeft, y: box.scrollTop,
    atEnd: atEnd(box, sign, vertical)
  };
}

function atEnd(box, sign, vertical) {
  if (vertical) return sign > 0 ? box.scrollTop + box.clientHeight >= box.scrollHeight - 2 : box.scrollTop <= 0;
  return sign > 0 ? box.scrollLeft + box.clientWidth >= box.scrollWidth - 2 : box.scrollLeft <= 0;
}

/* The largest visible, on-screen element that can scroll on the given axis. */
function mainScroller(vertical) {
  var best = null, bestArea = 0;
  var all = document.querySelectorAll('*');
  for (var i = 0; i < all.length; i++) {
    var e = all[i];
    var room = vertical ? e.scrollHeight - e.clientHeight : e.scrollWidth - e.clientWidth;
    if (room < 20) continue;
    var cs = getComputedStyle(e);
    var ov = cs[vertical ? 'overflowY' : 'overflowX'];
    if (ov !== 'auto' && ov !== 'scroll' && ov !== 'overlay') continue;
    if (cs.visibility !== 'visible' || axHidden(e)) continue;
    var r = e.getBoundingClientRect();
    var w = Math.min(r.right, window.innerWidth) - Math.max(r.left, 0);
    var h = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
    if (w <= 0 || h <= 0) continue;
    if (w * h > bestArea) { best = e; bestArea = w * h; }
  }
  return best;
}

function describe(el) {
  var r = elToRef.get(el);
  if (r !== undefined) return 'ref=' + r;
  return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '');
}

/* ------------------------------------------------------------------- keys */

var KEY_ALIASES = {
  esc: 'Escape', escape: 'Escape', enter: 'Enter', 'return': 'Enter', tab: 'Tab', space: ' ', spacebar: ' ',
  backspace: 'Backspace', 'delete': 'Delete', del: 'Delete', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft',
  right: 'ArrowRight', arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight',
  pageup: 'PageUp', pagedown: 'PageDown', home: 'Home', end: 'End'
};
var KEY_CODES = {
  Backspace: 8, Tab: 9, Enter: 13, Escape: 27, ' ': 32, PageUp: 33, PageDown: 34, End: 35, Home: 36,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46
};

function normalizeMods(mods) {
  if (!Array.isArray(mods)) mods = mods ? [mods] : [];
  var out = { ctrlKey: false, shiftKey: false, altKey: false, metaKey: false };
  mods.forEach(function (m) {
    var k = String(m).toLowerCase().replace(/key$/, '');
    if (k === 'ctrl' || k === 'control') out.ctrlKey = true;
    else if (k === 'shift') out.shiftKey = true;
    else if (k === 'alt' || k === 'option') out.altKey = true;
    else if (k === 'meta' || k === 'cmd' || k === 'command' || k === 'super' || k === 'win' || k === 'os') out.metaKey = true;
    else throw be('INVALID_PARAMS', 'Unknown modifier: ' + m);
  });
  return out;
}

/* The focused element, inside open shadow roots too. */
function deepActive() {
  var a = document.activeElement;
  while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
  return a;
}

/* Would a real keystroke edit el now? (The page's handlers may have moved
   focus, disabled or removed it.) */
function canEdit(el) {
  return el.isConnected && !isDisabled(el) && !el.readOnly && !isInert(el) && deepActive() === el;
}

/* Elements matching sel in document order, descending into open shadow roots
 * where their hosts sit. */
function deepQueryAll(root, sel, out) {
  out = out || [];
  var all = root.querySelectorAll('*');
  for (var i = 0; i < all.length; i++) {
    var e = all[i];
    if (e.matches(sel)) out.push(e);
    if (e.shadowRoot) deepQueryAll(e.shadowRoot, sel, out);
  }
  return out;
}

/* Focusable elements in tab order (positive tabindex first, then DOM order). */
function tabOrder() {
  var all = deepQueryAll(document, 'a[href], area[href], button, input, select, textarea, iframe, summary, [tabindex], [contenteditable=""], [contenteditable="true"]');
  var pos = [], zero = [];
  for (var i = 0; i < all.length; i++) {
    var e = all[i];
    if (isDisabled(e) || inputType(e) === 'hidden' || !visible(e)) continue;
    var ti = e.tabIndex;
    if (ti < 0) continue;
    (ti > 0 ? pos : zero).push(e);
  }
  pos.sort(function (a, b) { return a.tabIndex - b.tabIndex; });
  return pos.concat(zero);
}

function insertText(el, s) {
  if (el.isContentEditable) {
    try { if (document.execCommand('insertText', false, s)) return true; } catch (e) {}
    return false;
  }
  if (typeof el.setRangeText !== 'function' || el.selectionStart === null) {
    nativeSetValue(el, String(el.value) + s);
  } else {
    var st = el.selectionStart, en = el.selectionEnd;
    var v = String(el.value);
    nativeSetValue(el, v.slice(0, st) + s + v.slice(en));
    try { el.setSelectionRange(st + s.length, st + s.length); } catch (e) {}
  }
  fireInput(el, s === '\n' ? 'insertLineBreak' : 'insertText', s);
  return true;
}

/* Character boundaries (grapheme clusters where supported, else code points),
   so keys never split an emoji or a letter with its accent. */
var graphemes = null;
try { graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' }); } catch (e) {}
function boundaries(v) {
  var out = [0];
  if (graphemes) {
    for (var it = graphemes.segment(v)[Symbol.iterator](), r = it.next(); !r.done; r = it.next()) {
      out.push(r.value.index + r.value.segment.length);
    }
  } else {
    for (var i = 0; i < v.length;) {
      i += (/[\uD800-\uDBFF]/.test(v[i]) && /[\uDC00-\uDFFF]/.test(v[i + 1] || '')) ? 2 : 1;
      out.push(i);
    }
  }
  return out;
}
function prevBoundary(v, i) {
  var b = boundaries(v), p = 0;
  for (var k = 0; k < b.length && b[k] < i; k++) p = b[k];
  return p;
}
function nextBoundary(v, i) {
  var b = boundaries(v);
  for (var k = 0; k < b.length; k++) if (b[k] > i) return b[k];
  return v.length;
}

/* Move the caret like the arrow/Home/End keys do: collapse a selection to its
   edge, or with Shift move only the selection's focus end. */
function moveCaret(el, key, shift) {
  var v = String(el.value), st = el.selectionStart, en = el.selectionEnd;
  var back = el.selectionDirection === 'backward';
  var anchor = back ? en : st, focus = back ? st : en;
  var to;
  if (key === 'ArrowLeft' || key === 'ArrowRight') {
    var right = key === 'ArrowRight';
    if (!shift && st !== en) to = right ? en : st;
    else to = right ? nextBoundary(v, focus) : prevBoundary(v, focus);
  } else {
    var multi = el.tagName === 'TEXTAREA';
    to = key === 'Home' ? (multi && focus > 0 ? v.lastIndexOf('\n', focus - 1) + 1 : 0)
      : (multi && v.indexOf('\n', focus) >= 0 ? v.indexOf('\n', focus) : v.length);
  }
  if (!shift) { el.setSelectionRange(to, to); return 'moved the caret'; }
  if (to < anchor) el.setSelectionRange(to, anchor, 'backward');
  else el.setSelectionRange(anchor, to, 'forward');
  return 'extended the selection';
}

function deleteText(el, forward) {
  if (el.isContentEditable) {
    try { return document.execCommand(forward ? 'forwardDelete' : 'delete', false); } catch (e) { return false; }
  }
  var st = el.selectionStart, en = el.selectionEnd;
  if (st === null || st === undefined) return false;
  var v = String(el.value);
  if (st === en) {
    if (forward) en = nextBoundary(v, en); else st = prevBoundary(v, st);
  }
  if (st === en) return false;
  nativeSetValue(el, v.slice(0, st) + v.slice(en));
  try { el.setSelectionRange(st, st); } catch (e) {}
  fireInput(el, forward ? 'deleteContentForward' : 'deleteContentBackward');
  return true;
}

/* Synthetic key events are untrusted, so the browser runs none of a key's
 * default actions. After the page's handlers run (and didn't cancel the key),
 * perform the common ones ourselves and say what happened. */
async function keyDefault(key, mods, el, msg) {
  var tag = el.tagName;
  var type = inputType(el);
  var text = isTextField(el);
  var cmd = mods.ctrlKey || mods.metaKey;
  if (cmd && key.toLowerCase() === 'a' && !mods.altKey) {
    if (text && typeof el.select === 'function') { el.select(); return 'selected all text in ' + describe(el); }
    try { document.execCommand('selectAll'); return 'selected all'; } catch (e) { return ''; }
  }
  if (cmd || mods.altKey) return '';
  switch (key) {
    case 'Tab': {
      var order = tabOrder();
      if (!order.length) return '';
      var i = order.indexOf(el);
      var next = order[(i < 0 ? (mods.shiftKey ? order.length : -1) : i) + (mods.shiftKey ? -1 : 1)];
      if (!next) next = order[mods.shiftKey ? order.length - 1 : 0];
      try { next.focus(); } catch (e) {}
      return document.activeElement === next ? 'focus moved to ' + describe(next) : '';
    }
    case 'Enter':
      if (tag === 'TEXTAREA' || el.isContentEditable) {
        if (!canEdit(el)) return '';
        if (el.isContentEditable) { try { document.execCommand(mods.shiftKey ? 'insertLineBreak' : 'insertParagraph'); } catch (e) {} }
        else insertText(el, '\n');
        return 'inserted a new line';
      }
      if (tag === 'A' || tag === 'BUTTON' || tag === 'SUMMARY' || type === 'submit' || type === 'button' || type === 'reset' ||
          type === 'image' || el.getAttribute('role') === 'button' || el.getAttribute('role') === 'link') {
        assertActionable(el, 'activating it');
        el.click();
        return 'activated ' + describe(el);
      }
      if (tag === 'INPUT' && (el.form || el.closest('form'))) {
        var r = await submitField(el, msg);
        return r.submitted ? 'submitted the form' + (r.via ? ' via ' + r.via : '') : (r.note || '');
      }
      return '';
    case ' ':
      if (text) { if (!canEdit(el)) return ''; insertText(el, ' '); return 'typed a space'; }
      if (tag === 'BUTTON' || type === 'checkbox' || type === 'radio' || type === 'submit' || type === 'button' ||
          el.getAttribute('role') === 'button' || el.getAttribute('role') === 'checkbox' || el.getAttribute('role') === 'switch') {
        assertActionable(el, 'activating it');
        el.click();
        return 'activated ' + describe(el);
      }
      scrollBy(0, (mods.shiftKey ? -1 : 1) * Math.round(window.innerHeight * 0.9));
      return 'scrolled the page';
    case 'Backspace': case 'Delete':
      if (text && canEdit(el)) return deleteText(el, key === 'Delete') ? 'deleted text' : '';
      return '';
    case 'ArrowUp': case 'ArrowDown':
      if (tag === 'SELECT' && !el.multiple) {
        if (isDisabled(el)) return '';
        var step = key === 'ArrowDown' ? 1 : -1;
        for (var ni = el.selectedIndex + step; ni >= 0 && ni < el.options.length; ni += step) {
          if (optionDisabled(el.options[ni])) continue;
          selectIndices(el, [ni]);
          return 'selected ' + JSON.stringify(el.options[ni].text.trim());
        }
        return '';
      }
      if (text) return '';
      scrollBy(0, key === 'ArrowDown' ? 40 : -40);
      return 'scrolled the page';
    case 'ArrowLeft': case 'ArrowRight':
      if (text) {
        if (typeof el.setSelectionRange === 'function' && el.selectionStart !== null) return moveCaret(el, key, mods.shiftKey);
        return '';
      }
      scrollBy(key === 'ArrowRight' ? 40 : -40, 0);
      return 'scrolled the page';
    case 'PageUp': case 'PageDown':
      if (text && tag !== 'TEXTAREA') return '';
      scrollBy(0, (key === 'PageDown' ? 1 : -1) * Math.round(window.innerHeight * 0.9));
      return 'scrolled the page';
    case 'Home': case 'End':
      if (text) {
        if (typeof el.setSelectionRange === 'function' && el.selectionStart !== null) return moveCaret(el, key, mods.shiftKey);
        return '';
      }
      doScroll({ to: key === 'Home' ? 'top' : 'bottom' });
      return 'scrolled to the ' + (key === 'Home' ? 'top' : 'bottom');
  }
  if (key.length === 1 || (key.length === 2 && /[\uD800-\uDBFF]/.test(key[0]))) {
    if (text && canEdit(el)) { insertText(el, mods.shiftKey ? key.toUpperCase() : key); return 'typed ' + JSON.stringify(key); }
  }
  return '';
}

async function doKey(msg) {
  var raw = String(msg.key);
  var key = KEY_ALIASES[raw.toLowerCase()] || raw;
  var mods = normalizeMods(msg.modifiers);
  var target = deepActive() || document.body;
  var init = Object.assign({}, mods);
  if (KEY_CODES[key] !== undefined) { init.keyCode = KEY_CODES[key]; init.which = KEY_CODES[key]; init.code = key === ' ' ? 'Space' : key; }
  else if (key.length === 1) {
    var up = key.toUpperCase();
    if (/[A-Z]/.test(up)) { init.code = 'Key' + up; init.keyCode = init.which = up.charCodeAt(0); }
    else if (/[0-9]/.test(key)) { init.code = 'Digit' + key; init.keyCode = init.which = key.charCodeAt(0); }
  }
  var combo = ['ctrlKey', 'altKey', 'shiftKey', 'metaKey'].filter(function (m) { return mods[m]; })
    .map(function (m) { return { ctrlKey: 'Ctrl', altKey: 'Alt', shiftKey: 'Shift', metaKey: 'Meta' }[m]; })
    .concat([key === ' ' ? 'Space' : key]).join('+');
  var opts = Object.assign({ key: key, bubbles: true, cancelable: true, composed: true }, init);
  // keydown (and keypress) first; the default action runs between them and keyup.
  var down = new KeyboardEvent('keydown', opts);
  target.dispatchEvent(down);
  var handled = down.defaultPrevented;
  var printable = key.length === 1 || /^[\uD800-\uDBFF][\uDC00-\uDFFF]$/.test(key);
  if (!handled && (printable || key === 'Enter') && !mods.ctrlKey && !mods.metaKey && !mods.altKey) {
    var press = new KeyboardEvent('keypress', opts);
    target.dispatchEvent(press);
    handled = press.defaultPrevented;
  }
  var effect = handled ? 'handled by the page' : await keyDefault(key, mods, target, msg);
  target.dispatchEvent(new KeyboardEvent('keyup', opts));
  return {
    pressed: combo,
    target: target === document.body ? 'page' : describe(target),
    effect: effect || 'none: only the page\'s own key handlers ran (browser shortcuts and other built-in actions can\'t be triggered)'
  };
}

var cancelled = new Set(); // opIds the background asked us to stop (expire after 2 min)

function checkCancel(msg) {
  if (msg && msg.opId && cancelled.has(String(msg.opId))) throw be('CANCELLED', 'The command was cancelled.');
}

function sleep(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }

async function doWait(msg) {
  var timeoutMs = msg.timeoutMs !== undefined ? Number(msg.timeoutMs) : 10000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) timeoutMs = 10000;
  timeoutMs = Math.min(timeoutMs, 60000);
  var start = Date.now();
  var wantText = (msg.text !== undefined && msg.text !== null && String(msg.text) !== '') ? String(msg.text).toLowerCase() : null;
  var wantSel = msg.selector ? String(msg.selector) : null;
  if (wantSel) {
    try { document.querySelector(wantSel); } catch (e) { throw be('INVALID_PARAMS', 'Bad selector: ' + wantSel); }
  }
  if (!wantText && !wantSel) {
    var until = start + Math.min(timeoutMs, 1000);
    for (var left; (left = until - Date.now()) > 0;) { checkCancel(msg); await sleep(Math.min(100, left)); }
    checkCancel(msg);
    return { found: true, elapsedMs: Date.now() - start };
  }
  for (;;) {
    checkCancel(msg);
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

/* Visible text matches: up to 20 with snippets, and how many there are in all. */
function doFind(msg) {
  var q = String(msg.query === undefined || msg.query === null ? '' : msg.query).toLowerCase();
  if (!q) throw be('INVALID_PARAMS', 'act.find needs a query');
  var root = document.body || document.documentElement;
  var matches = [], count = 0;
  var shown = new Map(); // parent element -> visible?
  if (!root) return { matches: matches, count: 0, truncated: false };
  // Text nodes in document order, including open shadow roots.
  (function walk(r) {
    var walker = document.createTreeWalker(r, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, null);
    for (var n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeType === 1) {
        if (n.shadowRoot) walk(n.shadowRoot);
        continue;
      }
      var parent = n.parentElement;
      if (!parent || SKIP_TAGS[parent.tagName]) continue;
      var val = n.nodeValue || '';
      var low = val.toLowerCase();
      var idx = low.indexOf(q);
      if (idx < 0) continue;
      var vis = shown.get(parent);
      if (vis === undefined) { vis = visible(parent); shown.set(parent, vis); }
      if (!vis) continue;
      for (; idx >= 0; idx = low.indexOf(q, idx + q.length)) {
        count++;
        if (matches.length >= 20) continue;
        var m = { snippet: val.slice(Math.max(0, idx - 30), idx + q.length + 30).replace(/\s+/g, ' ').trim() };
        var ref = elToRef.get(parent);
        if (ref !== undefined) m.ref = ref;
        matches.push(m);
      }
    }
  })(root);
  return { matches: matches, count: count, truncated: count > matches.length };
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

/* A field whose contents shouldn't be shown in the cursor bubble. */
function isSecret(el) {
  if (!el || !el.getAttribute) return false;
  if (inputType(el) === 'password') return true;
  if (/password|one-time-code/i.test(el.getAttribute('autocomplete') || '')) return true;
  try { return !!(el.querySelector && el.querySelector('input[type="password"]')); } catch (e) { return false; }
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
    case 'act-type': {
      var field = null;
      try { field = el && editableTarget(el); } catch (e) {}
      dflt = !el ? 'Typing' : (isSecret(el) || isSecret(field)) ? 'Typing a password' : 'Typing' + quoted(msg.text);
      break;
    }
    case 'act-fillForm': dflt = 'Filling in a form'; break;
    case 'act-select': dflt = 'Choosing' + quoted((msg.values || []).join(', ')); break;
    case 'act-hover': dflt = 'Hovering over' + quoted(name); break;
    case 'act-scroll':
      dflt = el ? 'Scrolling to' + quoted(name) : msg.to ? 'Scrolling to the ' + msg.to : 'Scrolling ' + String(msg.direction || 'down');
      break;
    case 'act-key': dflt = isSecret(deepActive()) ? 'Pressing a key' : 'Pressing ' + String(msg.key); break;
    case 'act-wait': dflt = 'Waiting for' + (quoted(msg.text || msg.selector) || ' the page'); break;
    case 'act-find': dflt = 'Looking for' + quoted(msg.query); break;
    default: dflt = 'Reading the page';
  }
  var shape = msg.kind === 'act-click' ? 'hand'
    : (msg.kind === 'act-type' || msg.kind === 'act-fillForm') ? 'text'
    : msg.kind === 'act-wait' ? 'wait' : 'arrow';
  if (el) {
    ensureVisible(el);
    await C.moveTo(el, note || dflt, shape);
  } else {
    C.say(note || dflt, shape);
  }
}

function cursorAfter(msg, result, err) {
  var C = window.__fxmcpCursor;
  if (!msg.cursor || !C) return;
  try {
    // Don't leave "Clicking …" up when nothing was clicked.
    if (err) C.say(err.code === 'CANCELLED' ? 'Stopped' : 'That didn’t work', 'arrow');
    else if (msg.kind === 'act-click' && result && result.clicked) C.click();
  } catch (e) {} // the overlay must never fail an action
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
  if (msg.kind === 'cancel') {
    if (msg.opId) { cancelled.add(String(msg.opId)); setTimeout(function () { cancelled.delete(String(msg.opId)); }, 120000); }
    return { ok: true };
  }
  checkCancel(msg);
  if (msg.cursor) await cursorBefore(msg);
  try {
    checkCancel(msg); // the glide takes a moment
    var result = await dispatch(msg);
    if (msg.cursor) cursorAfter(msg, result, null);
    return result;
  } catch (e) {
    if (msg.cursor) cursorAfter(msg, null, e);
    throw e;
  }
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
      try {
        var tr = document.body || document.documentElement;
        t = tr ? tr.innerText || '' : '';
      } catch (e) { t = ''; }
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
    case 'act-key': return await doKey(msg);
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
