/* WebMCP Controller — options page logic (plain classic script). */
(function () {
'use strict';

var B = (typeof browser !== 'undefined') ? browser : chrome;
var F = window.FxMcp;

var $ = function (id) { return document.getElementById(id); };
var tokenEl = $('token'), portEl = $('port'), bindEl = $('bind'), saveEl = $('save'), formErr = $('formErr');
var cfgEl = $('cfg');
var kindEls = Array.prototype.slice.call(document.querySelectorAll('input[name=kind]'));
var toggles = { allowWsl: $('allowWsl'), showCursor: $('showCursor'), confirmDestructive: $('confirmDestructive') };
var pending = {};      // toggles with a save in flight: don't let a poll flip them back
var last = null;
var setupFor = '';

function send(msg) { return Promise.resolve(B.runtime.sendMessage(msg)); }

/* Only touch the DOM when something changed, so polling never resets selections or focus. */
function setText(el, text) { if (el.textContent !== text) el.textContent = text; }
function setHidden(el, hidden) { if (el.hidden !== hidden) el.hidden = hidden; }

var toastTimer = 0;
function toast(text, isErr) {
  var t = $('toast');
  t.textContent = text;
  t.className = 'show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { t.className = isErr ? 'err' : ''; }, isErr ? 4000 : 1600);
}
function errText(e) { return (e && e.message) || String(e); }

/* ---- kind (which harness) ---- */
function kind() {
  var k = kindEls.filter(function (el) { return el.checked; })[0];
  return k ? k.value : 'json';
}
function setKind(k) {
  var el = kindEls.filter(function (x) { return x.value === k && !x.parentNode.hidden; })[0] ||
    kindEls.filter(function (x) { return x.value === 'json'; })[0];
  el.checked = true;
}

var HINTS = {
  claude: 'Run this in a terminal. It replaces any “firefox” server Claude Code already has.',
  claudeWin: 'Run this in PowerShell. It replaces any “firefox” server Claude Code already has.',
  wsl: 'Run this in your WSL terminal. It replaces any “firefox” server Claude Code already has.',
  json: 'Add this to your client’s MCP config file, next to any servers already there.',
  opencode: 'Merge this into opencode.json (in your project, or ~/.config/opencode/).'
};

/* ---- rendering ---- */
function renderStatus(st) {
  var sum = F.summarize(st);
  $('dot').className = 'dot ' + sum.cls;
  setText($('stateTxt'), sum.text);
  setText($('stateErr'), st.listening ? '' : ((st.host && st.host.error) || (st.hostMissing ? '' : st.lastError) || ''));
  var bits = [];
  if (st.listening) bits.push(F.mcpUrl(st), (st.commands || 0) + ' commands');
  if (st.host && st.host.version) bits.push('helper v' + st.host.version);
  bits.push('add-on v' + (st.version || '?'));
  setText($('stateSub'), bits.join('  ·  '));
  setHidden($('retry'), !!st.listening);
}

function renderInstall(st) {
  var need = F.setupNeed(st);
  var s = F.hostSetup(st.platform);
  var installed = st.host && st.host.version;
  setText($('installTitle'), need ? need.title : 'Helper app');
  setText($('helperInfo'), (installed ? 'v' + st.host.version + ' installed · ' : '') + s.os);
  setText($('uninstallCmd'), s.uninstall);
  // Missing or too old: steps up front, card first. Otherwise tucked away at the bottom.
  var urgent = !!(need && !need.soft);
  $('install').classList.toggle('attention', urgent);
  $('install').style.order = urgent ? '-1' : '1';
  var key = JSON.stringify(st.platform) + '|' + (need ? need.title + need.intro : '');
  if (setupFor !== key) {
    setupFor = key;
    var now = $('setupNow'), later = $('setupLaterBody');
    now.textContent = '';
    later.textContent = '';
    if (need) F.renderSetup(now, st.platform, need.intro, !st.hostMissing);
    else F.renderSetup(later, st.platform, '', true);
    setHidden($('setupLater'), !!need);
  }
  // Re-check while missing so the page goes green right after the install command.
  if (st.hostMissing && Date.now() - lastProbe > 3000) {
    lastProbe = Date.now();
    send({ type: 'probe' }).catch(function () {});
  }
}
var lastProbe = 0;

function renderConnect(st) {
  var win = !!(st.platform && st.platform.os === 'win');
  if ($('kindWsl').hidden === win) {
    $('kindWsl').hidden = !win;
    if (!win && kind() === 'wsl') { setKind('claude'); F.configKind('claude'); }
  }
  var k = kind();
  setText($('kindHint'), HINTS[k === 'claude' && win ? 'claudeWin' : k]);
  setText(cfgEl, F.mcpConfig(st, k));
  setHidden($('wsl'), k !== 'wsl');
  var extra = (st.host && st.host.extraUrls) || [];
  var ws = $('wslState');
  if (!st.allowWsl) {
    ws.className = 'warn';
    setText(ws, 'Off — Claude Code in WSL can’t reach Firefox until you turn this on.');
  } else if (extra.length) {
    ws.className = 'ok';
    setText(ws, '✓ WSL can connect at ' + extra.join(', '));
  } else {
    ws.className = 'warn';
    setText(ws, st.listening ? 'No WSL network adapter found. Is WSL running?' : 'Starting…');
  }
}

function dirty() {
  return !!last && (portEl.value.trim() !== String(last.port) || bindEl.value.trim() !== last.bind);
}

function renderSettings(st) {
  Object.keys(toggles).forEach(function (k) {
    if (!pending[k] && typeof st[k] === 'boolean') toggles[k].checked = st[k];
  });
  if (tokenEl.value !== (st.token || '')) tokenEl.value = st.token || '';
  // Keep what the user is typing; otherwise follow the saved values.
  var editing = document.activeElement === portEl || document.activeElement === bindEl;
  if (!editing && !saveEl.dataset.dirty) {
    if (portEl.value !== String(st.port)) portEl.value = st.port;
    if (bindEl.value !== st.bind) bindEl.value = st.bind;
  }
  updateSave();
}

function updateSave() {
  var d = dirty();
  saveEl.disabled = !d;
  if (d) saveEl.dataset.dirty = '1'; else delete saveEl.dataset.dirty;
}

function render(st) {
  if (!st) {
    $('dot').className = 'dot off';
    setText($('stateTxt'), 'The add-on didn’t answer');
    setText($('stateErr'), 'Reload this page. If it keeps happening, restart Firefox.');
    return;
  }
  if (st.error) return;
  last = st;
  renderStatus(st);
  renderInstall(st);
  renderConnect(st);
  renderSettings(st);
}

function refresh() {
  return send({ type: 'get-status' }).then(render).catch(function (e) {
    $('dot').className = 'dot off';
    setText($('stateTxt'), 'Can’t reach the add-on');
    setText($('stateErr'), errText(e));
  });
}

/* ---- actions ---- */
$('retry').addEventListener('click', function () { send({ type: 'reconnect' }).then(render).catch(function () {}); });

function copyFrom(text, btn) {
  F.copy(text, btn).catch(function (e) { toast(errText(e), true); });
}
$('copyCfg').addEventListener('click', function () { copyFrom(cfgEl.textContent, this); });
$('copyToken').addEventListener('click', function () { copyFrom(tokenEl.value, this); });

$('reveal').addEventListener('click', function () {
  var show = tokenEl.type === 'password';
  tokenEl.type = show ? 'text' : 'password';
  this.textContent = show ? 'Hide' : 'Show';
});

setKind(F.configKind());
kindEls.forEach(function (el) {
  el.addEventListener('change', function () {
    F.configKind(el.value);
    if (last) renderConnect(last);
  });
});

/* Toggles apply right away. */
Object.keys(toggles).forEach(function (k) {
  toggles[k].addEventListener('change', function () {
    var msg = { type: 'set-config' };
    msg[k] = toggles[k].checked;
    pending[k] = true;
    send(msg).then(function (res) {
      if (res && res.error) throw new Error(res.error);
      pending[k] = false;
      render(res);
      toast('Saved');
    }).catch(function (e) {
      pending[k] = false;
      if (last) toggles[k].checked = last[k];
      toast('Couldn’t save: ' + errText(e), true);
    });
  });
});

/* "New token" asks once more on the button itself. */
var regenTimer = 0;
$('regen').addEventListener('click', function () {
  var btn = this;
  if (!btn.classList.contains('danger')) {
    btn.classList.add('danger');
    btn.textContent = 'Click again to replace';
    regenTimer = setTimeout(function () { btn.classList.remove('danger'); btn.textContent = 'New token'; }, 4000);
    return;
  }
  clearTimeout(regenTimer);
  btn.classList.remove('danger');
  btn.textContent = 'New token';
  send({ type: 'regenerate-token' }).then(function (st) {
    render(st);
    toast('New token active. Copy the config into your AI again.');
  }).catch(function (e) { toast('Couldn’t make a new token: ' + errText(e), true); });
});

[portEl, bindEl].forEach(function (el) {
  el.addEventListener('input', function () {
    el.removeAttribute('aria-invalid');
    formErr.textContent = '';
    updateSave();
  });
});

$('reset').addEventListener('click', function () {
  if (!last) return;
  portEl.value = last.defaults.port;
  bindEl.value = last.defaults.bind;
  portEl.removeAttribute('aria-invalid');
  bindEl.removeAttribute('aria-invalid');
  formErr.textContent = '';
  updateSave();
  if (dirty()) saveEl.focus();
});

$('form').addEventListener('submit', function (ev) {
  ev.preventDefault();
  if (!dirty()) return;
  saveEl.disabled = true;
  formErr.textContent = '';
  send({ type: 'set-config', port: portEl.value.trim(), bind: bindEl.value.trim() }).then(function (res) {
    if (res && res.error) {
      formErr.textContent = res.error;
      (/^Port/.test(res.error) ? portEl : bindEl).setAttribute('aria-invalid', 'true');
      updateSave();
      return;
    }
    delete saveEl.dataset.dirty;
    portEl.value = res.port;
    bindEl.value = res.bind;
    render(res);
    toast('Saved. Copy the config into your AI again if the port changed.');
  }).catch(function (e) {
    formErr.textContent = 'Couldn’t save: ' + errText(e);
    updateSave();
  });
});

refresh();
setInterval(refresh, 1500);
})();
