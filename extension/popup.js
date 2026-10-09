/* WebMCP Controller — toolbar popup logic (plain classic script). */
(function () {
'use strict';

var B = (typeof browser !== 'undefined') ? browser : chrome;
var F = window.FxMcp;

var $ = function (id) { return document.getElementById(id); };
var dotEl = $('dot'), stateEl = $('state'), detailEl = $('detail'), errEl = $('err'), setupEl = $('setup');
var copyBtn = $('copy'), pauseBtn = $('pause'), cursorEl = $('cursor');
var last = null;
var stepsFor = '';
var busy = false; // a pause/resume is in flight

function send(msg) { return Promise.resolve(B.runtime.sendMessage(msg)); }
function setText(el, text) { if (el.textContent !== text) el.textContent = text; }

function ago(ts) {
  var s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return s + ' s';
  if (s < 3600) return Math.round(s / 60) + ' min';
  return Math.round(s / 3600) + ' h';
}

function renderSteps(st, need) {
  var key = JSON.stringify(st.platform) + need.intro;
  if (stepsFor === key) return;
  stepsFor = key;
  F.renderSetup(setupEl, st.platform, need.intro);
}

/* While the helper is missing, re-check every few seconds so the popup goes
 * green as soon as the install command finishes. */
var lastRetry = 0;
function autoRetry(st) {
  if (!st.hostMissing || Date.now() - lastRetry < 3000) return;
  lastRetry = Date.now();
  send({ type: 'probe' }).catch(function () {});
}

function renderNow(st) {
  var n = st.now;
  $('now').hidden = !st.listening || !n;
  if (!n) return;
  $('nowLbl').className = n.active ? 'live' : '';
  setText($('nowLbl'), n.active ? 'Now' : 'Last · ' + ago(n.at) + ' ago');
  setText($('nowText'), n.text);
  setText($('nowSite'), n.site || '');
}

function renderPause(st) {
  pauseBtn.hidden = !st.listening && !st.paused;
  setText($('pauseTxt'), st.paused ? 'Resume AI' : 'Pause AI');
  $('pauseIcon').style.display = st.paused ? 'none' : '';
  $('playIcon').style.display = st.paused ? '' : 'none';
}

function render(st) {
  if (!st || st.error) return;
  last = st;
  var sum = F.summarize(st);
  dotEl.className = 'dot ' + sum.cls;
  setText(stateEl, sum.text);
  setText(errEl, st.listening ? '' : ((st.host && st.host.error) || (st.hostMissing ? '' : st.lastError) || ''));
  var need = F.setupNeed(st);
  setupEl.hidden = !need;
  if (need) renderSteps(st, need);
  autoRetry(st);
  copyBtn.hidden = !st.listening;
  $('retry').hidden = !!st.listening;
  if (!busy) renderPause(st);
  renderNow(st);
  if (document.activeElement !== cursorEl) cursorEl.checked = st.showCursor !== false;
  var bits = [];
  if (st.host && st.host.version) bits.push('Helper v' + st.host.version);
  if (st.listening) bits.push('up ' + ago(st.connectedAt), (st.commands || 0) + ' commands');
  setText(detailEl, bits.join(' · '));
}

function poll() {
  send({ type: 'get-status' })
    .then(render)
    .catch(function (e) {
      setText(stateEl, 'Status error');
      setText(errEl, String((e && e.message) || e));
    });
}

copyBtn.addEventListener('click', function () {
  if (last) F.copy(F.mcpConfig(last, F.configKind(), F.configWhere()), copyBtn).catch(function () {});
});

pauseBtn.addEventListener('click', function () {
  if (!last || busy) return;
  busy = true;
  send({ type: 'set-paused', paused: !last.paused })
    .then(function (st) { busy = false; render(st); })
    .catch(function (e) { busy = false; setText(errEl, String((e && e.message) || e)); });
});

cursorEl.addEventListener('change', function () {
  send({ type: 'set-config', showCursor: cursorEl.checked }).then(render).catch(function () {});
});

$('retry').addEventListener('click', function () {
  setText(stateEl, 'Retrying…');
  send({ type: 'reconnect' }).then(render).catch(function () {});
});

function openSettings(ev) {
  ev.preventDefault();
  B.runtime.openOptionsPage();
  window.close();
}
$('open').addEventListener('click', openSettings);
$('gear').addEventListener('click', openSettings);

/* Show the real pause shortcut, which the user may have changed in about:addons. */
Promise.resolve(B.commands && B.commands.getAll ? B.commands.getAll() : [])
  .then(function (cmds) {
    var c = (cmds || []).filter(function (x) { return x.name === 'toggle-pause'; })[0];
    if (c && c.shortcut) setText($('shortcut'), 'Shortcut: ' + c.shortcut.replace(/Period$/, '.') + ' pauses');
  })
  .catch(function () {});

poll();
setInterval(poll, 1000);
})();
