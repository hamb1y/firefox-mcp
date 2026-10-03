/* WebMCP Controller — helpers shared by popup + options (plain classic script). */
(function () {
'use strict';

var BIN = 'webmcp-host';
var DOWNLOAD = 'https://github.com/hamb1y/webmcp-controller/releases/latest/download/';

/* runtime.getPlatformInfo() -> download + one-line install for this computer. */
function hostSetup(platform) {
  var os = (platform && platform.os) || '';
  var arch = (platform && platform.arch) || '';
  var a = /arm|aarch/.test(arch) ? 'arm64' : 'x64';
  if (os === 'win') {
    return {
      os: 'Windows',
      open: 'Open PowerShell or Command Prompt (Start menu → type “powershell” → Enter) and paste:',
      cmd: 'powershell -ExecutionPolicy Bypass -c "irm ' + DOWNLOAD + 'install.ps1 | iex"',
      file: BIN + '-windows-' + a + '.exe',
      uninstall: '& "$env:LOCALAPPDATA\\webmcp-controller\\webmcp-host.exe" uninstall',
      manual: 'or download the app and double-click it (SmartScreen: More info → Run anyway)'
    };
  }
  var mac = os === 'mac';
  var file = BIN + '-' + (mac ? 'darwin' : 'linux') + '-' + a;
  return {
    os: mac ? 'macOS' : 'Linux',
    open: mac ? 'Open Terminal (⌘ Space → type “terminal” → Enter) and paste:' : 'Open a terminal and paste:',
    cmd: 'curl -fsSL ' + DOWNLOAD + 'install.sh | sh',
    file: file,
    uninstall: (mac ? '~/Library/Application\\ Support' : '~/.local/share') + '/webmcp-controller/webmcp-host uninstall',
    manual: 'or download the app, then run: chmod +x ' + file + ' && ./' + file + ' install'
  };
}

/* Install instructions as DOM: command + Copy, direct download link.
 * intro: optional sentence shown first (e.g. why an update is needed).
 * installed: the helper already runs, so don't promise the page will turn green. */
function renderSetup(container, platform, intro, installed) {
  var s = hostSetup(platform);
  container.textContent = '';
  if (intro) {
    var i = document.createElement('div');
    i.className = 'intro';
    i.textContent = intro;
    container.appendChild(i);
  }
  var p = document.createElement('div');
  p.textContent = s.open;
  var pre = document.createElement('pre');
  pre.className = 'cmd';
  pre.textContent = s.cmd;
  var row = document.createElement('div');
  row.className = 'row';
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'primary';
  btn.textContent = 'Copy command';
  btn.addEventListener('click', function () { copy(s.cmd, btn).catch(function () {}); });
  var dl = document.createElement('a');
  dl.href = DOWNLOAD + s.file;
  dl.className = 'button';
  dl.textContent = 'Download app';
  dl.target = '_blank';
  dl.rel = 'noopener';
  row.appendChild(btn);
  row.appendChild(dl);
  var m = document.createElement('div');
  m.className = 'sub';
  m.textContent = s.manual + (installed ? '.' : '. This page turns green by itself once it’s installed.');
  [p, pre, row, m].forEach(function (el) { container.appendChild(el); });
  return s;
}

function mcpUrl(st) {
  if (st && st.url) return st.url;
  var host = !st || st.bind === '0.0.0.0' || st.bind === '::' ? '127.0.0.1' : st.bind;
  return 'http://' + host + ':' + ((st && st.port) || 8901) + '/mcp';
}

/* `claude mcp add` refuses a name that already exists, so drop any old "firefox" entry first
 * (e.g. one holding a token from before a reinstall). User scope: it works from every folder. */
function claudeAdd(url, auth, shell) {
  var quiet = shell === 'powershell' ? ' 2>$null' : ' 2>/dev/null';
  return 'claude mcp remove --scope user firefox' + quiet + '; claude mcp add --scope user --transport http firefox "' +
    url + '" --header "Authorization: ' + auth + '"';
}

/* Harness config snippets. kind: 'json' | 'claude' | 'opencode' | 'wsl'. */
function mcpConfig(st, kind) {
  var url = mcpUrl(st);
  var auth = 'Bearer ' + ((st && st.token) || '');
  if (kind === 'wsl') {
    // WSL's default gateway is Windows' WSL adapter, which the helper listens on when "Allow WSL" is on.
    // Looked up when the command runs; it changes when Windows restarts.
    var wslUrl = url.replace(/^http:\/\/[^/]+/, 'http://$(ip route show default | awk \'{print $3}\'):' + ((st && st.port) || 8901));
    return claudeAdd(wslUrl, auth, 'sh');
  }
  if (kind === 'claude') {
    return claudeAdd(url, auth, st && st.platform && st.platform.os === 'win' ? 'powershell' : 'sh');
  }
  if (kind === 'opencode') {
    return JSON.stringify({ mcp: { firefox: { type: 'remote', url: url, headers: { Authorization: auth } } } }, null, 2);
  }
  return JSON.stringify({ mcpServers: { firefox: { type: 'http', url: url, headers: { Authorization: auth } } } }, null, 2);
}

function copy(text, btn) {
  var write = navigator.clipboard && navigator.clipboard.writeText
    ? navigator.clipboard.writeText(text)
    : Promise.reject(new Error('no clipboard'));
  return write.catch(function () {
    // Fallback for when the async clipboard is unavailable.
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    if (!ok) throw new Error('Copy failed — select the text and press Ctrl+C');
  }).then(function () {
    if (!btn) return;
    var old = btn.textContent;
    btn.textContent = 'Copied ✓';
    btn.classList.add('copied');
    setTimeout(function () { btn.textContent = old; btn.classList.remove('copied'); }, 1200);
  });
}

/* What the install section should say, or null when nothing needs installing. */
function setupNeed(st) {
  st = st || {};
  var c = st.compat || {};
  if (st.hostMissing) return { title: 'Install the helper app', intro: '' };
  if (c.state === 'helper-old') {
    return { title: 'Update the helper app', intro: 'Your helper app (v' + c.helper + ') is too old for this add-on (v' + c.addon + '). Run this again:' };
  }
  if (c.state === 'helper-update') {
    return { title: 'Helper update available', intro: 'Helper v' + c.helper + ' works, but v' + c.addon + ' is out. To update, run this again:', soft: true };
  }
  return null;
}

/* One status line for the dot + headline. */
function summarize(st) {
  st = st || {};
  var c = (st.compat && st.compat.state) || '';
  if (st.listening) return { cls: 'on', text: c === 'helper-update' ? 'Ready · helper update available' : 'Ready' };
  if (st.hostMissing) return { cls: 'warn', text: 'Helper app not installed' };
  if (c === 'helper-old') return { cls: 'warn', text: 'Helper app needs an update' };
  if (c === 'addon-old') return { cls: 'warn', text: 'Add-on needs an update' };
  if (st.starting) return { cls: 'wait', text: 'Starting helper…' };
  if (st.connected && st.host && st.host.error) return { cls: 'off', text: 'Helper can’t open its port' };
  if (st.connected) return { cls: 'wait', text: 'Starting MCP server…' };
  return { cls: 'off', text: 'Helper not running' };
}

/* Last config format picked in settings; the popup's Copy button uses it too. */
function configKind(set) {
  try {
    if (set) localStorage.setItem('fxmcp.kind', set);
    return localStorage.getItem('fxmcp.kind') || 'json';
  } catch (e) { return set || 'json'; }
}

window.FxMcp = {
  hostSetup: hostSetup, renderSetup: renderSetup, setupNeed: setupNeed, mcpUrl: mcpUrl,
  mcpConfig: mcpConfig, configKind: configKind, copy: copy, summarize: summarize
};
})();
