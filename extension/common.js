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

/* `claude mcp add` / `gemini mcp add` refuse a name that already exists, so drop any old "firefox"
 * entry first (e.g. one holding a token from before a reinstall). User scope: works from every folder. */
function cliAdd(cli, url, auth, shell) {
  var quiet = shell === 'powershell' ? ' 2>$null' : ' 2>/dev/null';
  return cli + ' mcp remove --scope user firefox' + quiet + '; ' + cli + ' mcp add --scope user --transport http firefox "' +
    url + '" --header "Authorization: ' + auth + '"';
}

var HARNESSES = ['claude', 'codex', 'gemini', 'opencode', 'json'];
var SHELL_HARNESSES = { claude: 'claude', gemini: 'gemini' };

/* Where the AI runs: 'local' (this computer) or 'wsl' (Linux under WSL, Firefox on Windows). */
function canWsl(st) { return !!(st && st.platform && st.platform.os === 'win'); }

/* The MCP URL as seen from where the AI runs. inShell: may use shell substitution. */
function urlFrom(st, where, inShell) {
  if (where !== 'wsl' || !canWsl(st)) return mcpUrl(st);
  var port = (st && st.port) || 8901;
  // WSL's default gateway is Windows' WSL adapter, which the helper listens on when "Allow WSL" is on.
  // A command looks it up when it runs (it changes when Windows restarts); a config file gets today's address.
  if (inShell) return 'http://$(ip route show default | awk \'{print $3}\'):' + port + '/mcp';
  var addr = (st.host && st.host.wslAddress) || 'WINDOWS-IP';
  return 'http://' + addr + ':' + port + '/mcp';
}

/* Config snippet for a harness. harness: one of HARNESSES ('wsl' = old name for Claude Code in WSL). */
function mcpConfig(st, harness, where) {
  if (harness === 'wsl') { harness = 'claude'; where = 'wsl'; }
  if (HARNESSES.indexOf(harness) < 0) harness = 'json';
  var wsl = where === 'wsl' && canWsl(st);
  var auth = 'Bearer ' + ((st && st.token) || '');
  var cli = SHELL_HARNESSES[harness];
  if (cli) return cliAdd(cli, urlFrom(st, where, true), auth, !wsl && st && st.platform && st.platform.os === 'win' ? 'powershell' : 'sh');
  var url = urlFrom(st, where, false);
  if (harness === 'codex') {
    return '[mcp_servers.firefox]\nurl = ' + JSON.stringify(url) + '\nhttp_headers = { Authorization = ' + JSON.stringify(auth) + ' }';
  }
  if (harness === 'opencode') {
    return JSON.stringify({ mcp: { firefox: { type: 'remote', url: url, headers: { Authorization: auth } } } }, null, 2);
  }
  return JSON.stringify({ mcpServers: { firefox: { type: 'http', url: url, headers: { Authorization: auth } } } }, null, 2);
}

/* What to do with the snippet. */
function configHint(st, harness, where) {
  var wsl = where === 'wsl' && canWsl(st);
  var win = !!(st && st.platform && st.platform.os === 'win');
  var term = wsl ? 'your WSL terminal' : win ? 'PowerShell' : 'a terminal';
  var name = { claude: 'Claude Code', gemini: 'Gemini CLI' }[harness];
  var h = name ? 'Run this in ' + term + '. It replaces any “firefox” server ' + name + ' already has.'
    : harness === 'codex' ? 'Add this to ~/.codex/config.toml' + (wsl ? ' inside WSL' : '') + ', replacing any [mcp_servers.firefox] section already there.'
    : harness === 'opencode' ? 'Merge this into opencode.json (in your project, or ~/.config/opencode/' + (wsl ? ' inside WSL' : '') + ').'
    : 'Add this to your client’s MCP config file' + (wsl ? ' inside WSL' : '') + ', next to any servers already there.';
  if (wsl && !name) {
    h += (st.host && st.host.wslAddress)
      ? ' The Windows address in it changes when Windows restarts: copy this again if your AI stops connecting.'
      : ' Replace WINDOWS-IP with the output of: ip route show default | awk \'{print $3}\'';
  }
  return h;
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

/* Last harness and place picked in settings; the popup's Copy button uses them too. */
function pref(key, set, fallback, allowed) {
  try {
    if (set) localStorage.setItem(key, set);
    var v = localStorage.getItem(key);
    return allowed.indexOf(v) >= 0 ? v : fallback;
  } catch (e) { return allowed.indexOf(set) >= 0 ? set : fallback; }
}
function migrateKind() {
  try {
    if (localStorage.getItem('fxmcp.kind') === 'wsl') {
      localStorage.setItem('fxmcp.kind', 'claude');
      localStorage.setItem('fxmcp.where', 'wsl');
    }
  } catch (e) {}
}
function configKind(set) { migrateKind(); return pref('fxmcp.kind', set, 'json', HARNESSES); }
function configWhere(set) { migrateKind(); return pref('fxmcp.where', set, 'local', ['local', 'wsl']); }

window.FxMcp = {
  hostSetup: hostSetup, renderSetup: renderSetup, setupNeed: setupNeed, mcpUrl: mcpUrl,
  mcpConfig: mcpConfig, configHint: configHint, configKind: configKind, configWhere: configWhere, canWsl: canWsl,
  copy: copy, summarize: summarize
};
})();
