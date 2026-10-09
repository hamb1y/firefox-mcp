/* WebMCP Controller — options page logic (plain classic script). */
(function () {
'use strict';

var B = (typeof browser !== 'undefined') ? browser : chrome;
var F = window.FxMcp;

var $ = function (id) { return document.getElementById(id); };
var tokenEl = $('token'), portEl = $('port'), bindEl = $('bind'), saveEl = $('save'), formErr = $('formErr');
var cfgEl = $('cfg');
var kindEls = Array.prototype.slice.call(document.querySelectorAll('input[name=kind]'));
var inWslEl = $('inWsl');
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

/* ---- which AI, and where it runs ---- */
function kind() {
  var el = kindEls.filter(function (x) { return x.checked; })[0];
  return el ? el.value : 'json';
}
function pickKind(value) {
  kindEls.forEach(function (x) { x.checked = x.value === value; });
}
function where() { return inWslEl.checked ? 'wsl' : 'local'; }

function since(ts) {
  var m = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return m + ' min';
  var h = Math.floor(m / 60);
  return h + ' h' + (m % 60 ? ' ' + (m % 60) + ' min' : '');
}

/* ---- rendering ---- */
var pausing = false;
function renderStatus(st) {
  var sum = F.summarize(st);
  $('dot').className = 'dot ' + sum.cls;
  setText($('stateTxt'), sum.text);
  setText($('stateErr'), st.listening ? '' : ((st.host && st.host.error) || (st.hostMissing ? '' : st.lastError) || ''));
  setText($('factHelper'), st.host && st.host.version ? 'v' + st.host.version : st.hostMissing ? 'Not installed' : '—');
  setText($('factUp'), st.listening && st.connectedAt ? since(st.connectedAt) + ' · ' + (st.commands || 0) + ' commands' : '—');
  setText($('factAddr'), st.listening ? F.mcpUrl(st).replace(/^http:\/\//, '').replace(/\/mcp$/, '') : '—');
  setText($('addonVer'), 'Add-on v' + (st.version || '?') + ' · ');
  setHidden($('retry'), !!st.listening);
  if (!pausing) {
    setHidden($('pause'), !st.listening && !st.paused);
    setText($('pause'), st.paused ? 'Resume AI' : 'Pause AI');
  }
}

function renderInstall(st) {
  var need = F.setupNeed(st);
  var s = F.hostSetup(st.platform);
  var installed = st.host && st.host.version;
  setText($('installTitle'), need ? need.title : 'Helper app');
  setText($('helperInfo'), (installed ? 'v' + st.host.version + ' installed on ' : 'For ') + s.os +
    (st.host && st.host.extraUrls && st.host.extraUrls.length ? ' · also on ' + st.host.extraUrls.join(', ') + ' for WSL' : ''));
  setText($('uninstallCmd'), s.uninstall);
  // Missing or too old: steps up front. An optional update sits further down. Otherwise tucked away.
  setHidden($('install'), !need);
  $('install').classList.toggle('attention', !!(need && !need.soft));
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
  var k = kind();
  var win = F.canWsl(st) && k !== 'claude-app'; // the Claude app runs on Windows itself
  setHidden($('whereRow'), !win);
  var w = win ? where() : 'local';
  setText($('kindHint'), F.configHint(st, k, w));
  setText(cfgEl, F.mcpConfig(st, k, w));
  setHidden($('wsl'), w !== 'wsl');
  var extra = (st.host && st.host.extraUrls) || [];
  var ws = $('wslState');
  if (!st.allowWsl) {
    ws.className = 'warn';
    setText(ws, 'Off: AIs in WSL can’t reach Firefox until you turn this on.');
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

var eventsKey = '';
function clock(ms) {
  var d = new Date(ms), now = new Date();
  return d.toDateString() === now.toDateString()
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
function span(cls, text) {
  var el = document.createElement('span');
  el.className = cls;
  el.textContent = text;
  return el;
}
function renderActivity(st) {
  var evs = st.events || [];
  var key = JSON.stringify(evs);
  if (key !== eventsKey) {
    eventsKey = key;
    var ul = $('events');
    ul.textContent = '';
    if (!evs.length) {
      var li0 = document.createElement('li');
      li0.appendChild(span('empty', 'Nothing yet.'));
      ul.appendChild(li0);
    }
    evs.slice().reverse().forEach(function (e) {
      var li = document.createElement('li');
      var tm = document.createElement('time');
      tm.dateTime = new Date(e.at).toISOString();
      tm.title = new Date(e.at).toLocaleString();
      tm.textContent = clock(e.at);
      var tx = span(e.level === 'bad' ? 'bad' : '', e.text);
      if (e.site) tx.appendChild(span('site', ' · ' + e.site));
      if (e.count > 1) tx.appendChild(span('count', ' ×' + e.count));
      li.appendChild(tm);
      li.appendChild(tx);
      ul.appendChild(li);
    });
  }
  var lf = (st.host && st.host.logFile) || '';
  setText($('logFile'), lf);
  setHidden($('logLine'), !lf);
}

function render(st) {
  if (!st) {
    $('dot').className = 'dot off';
    setText($('stateTxt'), 'The add-on didn’t answer');
    setText($('stateErr'), 'Reload this page. If it keeps happening, restart Firefox.');
    setHidden($('retry'), false);
    return;
  }
  if (st.error) return;
  last = st;
  renderStatus(st);
  renderInstall(st);
  renderConnect(st);
  renderSettings(st);
  renderActivity(st);
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

$('pause').addEventListener('click', function () {
  if (!last || pausing) return;
  pausing = true;
  send({ type: 'set-paused', paused: !last.paused }).then(function (st) {
    pausing = false;
    render(st);
  }).catch(function (e) {
    pausing = false;
    toast('Couldn’t pause: ' + errText(e), true);
  });
});

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

pickKind(F.configKind());
inWslEl.checked = F.configWhere() === 'wsl';
kindEls.forEach(function (el) {
  el.addEventListener('change', function () {
    F.configKind(el.value);
    if (last) renderConnect(last);
  });
});
inWslEl.addEventListener('change', function () {
  F.configWhere(where());
  if (last) renderConnect(last);
  // Saying the AI is in WSL means you want WSL to connect: switch it on rather than leave a dead config.
  if (inWslEl.checked && last && !last.allowWsl) {
    toggles.allowWsl.checked = true;
    toggles.allowWsl.dispatchEvent(new Event('change'));
  }
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
      toast(k === 'allowWsl' && res.allowWsl ? 'WSL access turned on' : 'Saved');
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
