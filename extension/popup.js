/* Firefox MCP Bridge — toolbar popup logic (plain classic script). */
(function () {
'use strict';

var B = (typeof browser !== 'undefined') ? browser : chrome;
var F = window.FxMcp;

var dotEl = document.getElementById('dot');
var stateEl = document.getElementById('state');
var detailEl = document.getElementById('detail');
var errEl = document.getElementById('err');
var setupEl = document.getElementById('setup');
var copyBtn = document.getElementById('copy');
var cursorEl = document.getElementById('cursor');
var last = null;
var stepsFor = '';

function ago(ts) {
  var s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return s + 's';
  if (s < 3600) return Math.round(s / 60) + 'm';
  return Math.round(s / 3600) + 'h';
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
  B.runtime.sendMessage({ type: 'probe' }).catch(function () {});
}

function render(st) {
  st = st || {};
  last = st;
  var sum = F.summarize(st);
  dotEl.className = 'dot ' + sum.cls;
  stateEl.textContent = sum.text;
  errEl.textContent = st.listening ? '' : ((st.host && st.host.error) || (st.hostMissing ? '' : st.lastError) || '');
  var need = F.setupNeed(st);
  setupEl.hidden = !need;
  if (need) renderSteps(st, need);
  autoRetry(st);
  copyBtn.hidden = !st.listening;
  if (document.activeElement !== cursorEl) cursorEl.checked = st.showCursor !== false;
  var lines = [];
  if (st.listening) {
    lines.push(F.mcpUrl(st));
    lines.push('up ' + ago(st.connectedAt) + ' · ' + (st.commands || 0) + ' commands · helper v' + ((st.host && st.host.version) || '?'));
    if (st.host && st.host.extraUrls && st.host.extraUrls.length) lines.push('WSL: ' + st.host.extraUrls.join(', '));
  }
  detailEl.textContent = lines.join('\n');
}

function poll() {
  Promise.resolve(B.runtime.sendMessage({ type: 'get-status' }))
    .then(render)
    .catch(function (e) {
      stateEl.textContent = 'Status error';
      errEl.textContent = String((e && e.message) || e);
    });
}

copyBtn.addEventListener('click', function () {
  if (last) F.copy(F.mcpConfig(last, F.configKind()), copyBtn).catch(function () {});
});

cursorEl.addEventListener('change', function () {
  Promise.resolve(B.runtime.sendMessage({ type: 'set-config', showCursor: cursorEl.checked })).then(render).catch(function () {});
});

document.getElementById('retry').addEventListener('click', function () {
  stateEl.textContent = 'Retrying…';
  Promise.resolve(B.runtime.sendMessage({ type: 'reconnect' })).then(render).catch(function () {});
});

document.getElementById('open').addEventListener('click', function () {
  B.runtime.openOptionsPage();
  window.close();
});

poll();
setInterval(poll, 1000);
})();
