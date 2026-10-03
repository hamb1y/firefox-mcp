/* Firefox MCP Bridge — options page logic (plain classic script). */
(function () {
'use strict';

var B = (typeof browser !== 'undefined') ? browser : chrome;
var F = window.FxMcp;

var $ = function (id) { return document.getElementById(id); };
var tokenEl = $('token'), portEl = $('port'), bindEl = $('bind'), msgEl = $('msg');
var kindEl = $('kind'), cfgEl = $('cfg');
var toggles = { allowWsl: $('allowWsl'), showCursor: $('showCursor'), confirmDestructive: $('confirmDestructive') };
var last = null;
var filled = false;
var stepsFor = '';

function send(msg) { return Promise.resolve(B.runtime.sendMessage(msg)); }

function showMsg(text, ok) {
  msgEl.textContent = text;
  msgEl.className = ok ? 'ok' : 'err';
}

var lastRetry = 0;
function renderSteps(st) {
  var need = F.setupNeed(st);
  var installed = !need && st.host && st.host.version;
  $('installTitle').textContent = need ? '1. ' + need.title
    : installed ? '1. Helper app v' + st.host.version + ' installed' : '1. Install the helper app';
  var intro = need ? need.intro : installed ? 'Installed and running. To reinstall or repair it, run this again:' : '';
  var key = JSON.stringify(st.platform) + intro;
  if (stepsFor !== key) {
    stepsFor = key;
    var s = F.renderSetup($('setup'), st.platform, intro);
    $('osName').textContent = '(' + s.os + ')';
    var win = !!(st.platform && st.platform.os === 'win');
    $('wsl').hidden = !win;
    $('kindWsl').hidden = !win;
    if (!win && kindEl.value === 'wsl') { kindEl.value = 'claude'; renderCfg(); }
  }
  $('install').style.opacity = need && !need.soft ? '1' : '.75';
  // Re-check while missing so the page goes green right after the install command.
  if (st.hostMissing && Date.now() - lastRetry > 3000) {
    lastRetry = Date.now();
    send({ type: 'probe' }).catch(function () {});
  }
}

function renderCfg() {
  if (last) cfgEl.value = F.mcpConfig(last, kindEl.value);
}

function render(st) {
  st = st || {};
  last = st;
  var sum = F.summarize(st);
  $('dot').className = 'dot ' + sum.cls;
  $('stateTxt').textContent = sum.text;
  var sub = $('stateSub');
  sub.textContent = '';
  var err = st.listening ? '' : ((st.host && st.host.error) || (st.hostMissing ? '' : st.lastError) || '');
  if (err) {
    var e = document.createElement('span');
    e.className = 'err';
    e.textContent = err;
    sub.appendChild(e);
    sub.appendChild(document.createElement('br'));
  }
  var bits = [];
  if (st.listening) bits.push(F.mcpUrl(st), (st.commands || 0) + ' commands');
  if (st.host && st.host.version) bits.push('helper v' + st.host.version);
  bits.push('add-on v' + (st.version || '?'));
  sub.appendChild(document.createTextNode(bits.join('  ·  ')));

  renderSteps(st);
  Object.keys(toggles).forEach(function (k) {
    if (document.activeElement !== toggles[k] && typeof st[k] === 'boolean') toggles[k].checked = st[k];
  });
  var extra = (st.host && st.host.extraUrls) || [];
  $('wslUrls').textContent = extra.length ? extra.join(', ')
    : st.allowWsl ? (st.listening ? 'no WSL adapter found — is WSL running?' : 'starting…') : 'off';
  tokenEl.value = st.token || '';
  if (!filled) {
    filled = true;
    portEl.value = st.port;
    bindEl.value = st.bind;
  }
  renderCfg();
}

function refresh() { return send({ type: 'get-status' }).then(render).catch(function () {}); }

$('retry').addEventListener('click', function () { send({ type: 'reconnect' }).then(render); });

$('reveal').addEventListener('click', function () {
  var hidden = tokenEl.type === 'password';
  tokenEl.type = hidden ? 'text' : 'password';
  this.textContent = hidden ? 'Hide' : 'Show';
});

$('copyToken').addEventListener('click', function () { F.copy(tokenEl.value, this); });
$('copyCfg').addEventListener('click', function () { F.copy(cfgEl.value, this); });
kindEl.value = F.configKind();
if (kindEl.selectedIndex < 0) kindEl.value = 'json';
kindEl.addEventListener('change', function () { F.configKind(kindEl.value); renderCfg(); });

/* Toggles apply right away; no Save needed. */
Object.keys(toggles).forEach(function (k) {
  toggles[k].addEventListener('change', function () {
    var msg = { type: 'set-config' };
    msg[k] = toggles[k].checked;
    send(msg).then(function (res) {
      if (res && res.error) { showMsg(res.error, false); return; }
      render(res);
    }).catch(function (e) { showMsg('Save failed: ' + ((e && e.message) || e), false); });
  });
});

$('regen').addEventListener('click', function () {
  if (!confirm('Make a new token? Harnesses using the old one stop working until you paste the new config.')) return;
  send({ type: 'regenerate-token' }).then(function (st) { render(st); showMsg('New token active — re-copy your config', true); });
});

$('reset').addEventListener('click', function () {
  if (!last) return;
  portEl.value = last.defaults.port;
  bindEl.value = last.defaults.bind;
});

$('form').addEventListener('submit', function (ev) {
  ev.preventDefault();
  send({ type: 'set-config', port: portEl.value.trim(), bind: bindEl.value.trim() }).then(function (res) {
    if (res && res.error) { showMsg(res.error, false); return; }
    render(res);
    portEl.value = res.port;
    bindEl.value = res.bind;
    showMsg('Saved', true);
  }).catch(function (e) { showMsg('Save failed: ' + ((e && e.message) || e), false); });
});

refresh();
setInterval(refresh, 1500);
})();
