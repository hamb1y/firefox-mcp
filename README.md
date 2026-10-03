# WebMCP Controller (firefox-mcp) — full-control Firefox MCP

Live Firefox (your **current profile, all tabs**) driven by any MCP harness
(Claude, opencode, Cursor, anything speaking Streamable HTTP). There is no
server to start: Firefox itself launches a small helper app (a native
messaging host) when the add-on loads, and the helper serves MCP.

While the model works, a glowing **AI cursor** glides to whatever it is
clicking or typing into, with a small bubble saying what it is doing
(toggle it in the popup).

**Install:** add the add-on, paste one command (below) to install the helper,
click **Copy MCP config** in the add-on popup, paste that into your harness.

## Architecture

```text
 Firefox                                   helper (native messaging host)        harness
+------------------------+  stdin/stdout  +-------------------------------+     +-----------------+
| WebExtension           | <------------> | firefox-mcp-host              |     | Claude / opencode|
| background.js          |  (Firefox      |  started & stopped by Firefox |     | / any MCP client |
|  connectNative(...)    |   launches it) |  127.0.0.1:8901/mcp  <---------------- POST /mcp       |
+------------------------+                +-------------------------------+     +-----------------+
```

- The add-on owns the settings: it generates the **token** on first run and
  pushes `{token, port, bind}` to the helper. Defaults: port **8901**, bind
  **127.0.0.1**.
- Harness → helper: MCP **Streamable HTTP** `POST /mcp`, authenticated with
  `Authorization: Bearer <token>`. Unauthenticated: `GET /health`, `GET /`.
- The helper lives exactly as long as the add-on is running — close Firefox
  and the MCP endpoint goes away.

Why an extension at all: Firefox's CDP/remote-debugging surface is incomplete,
while a privileged WebExtension gets every tab, window, bookmark, history entry
and cookie of the profile you actually use. Why a native host: extensions
cannot listen on ports, and native messaging is the one sanctioned way for an
add-on to talk to a local program — no manual server, no extra login.

## Quickstart

### 1. Install the helper (once per computer)

The add-on's popup shows this for your system with a **Copy command** button.

**Windows** — open PowerShell or Command Prompt and paste:

```bat
powershell -ExecutionPolicy Bypass -c "irm https://github.com/hamb1y/firefox-mcp/releases/latest/download/install.ps1 | iex"
```

**macOS / Linux / WSL** — open Terminal and paste (inside WSL it installs the Windows helper for you):

```sh
curl -fsSL https://github.com/hamb1y/firefox-mcp/releases/latest/download/install.sh | sh
```

The script picks the right binary (x64/arm64), checks its SHA-256 and runs
`install`. Prefer clicking? Grab `firefox-mcp-host-<os>-<arch>` from the
[releases page](https://github.com/hamb1y/firefox-mcp/releases/latest) — on
Windows double-click the `.exe`; elsewhere `chmod +x` it and run it with `install`.

Already installed? Run the same command again to **update**: Firefox switches
to the new helper by itself within a few seconds, no restart needed.

`install` copies the binary to a per-user folder and registers it with Firefox
(no admin rights needed). The downloaded file can be deleted afterwards.

| OS | Binary goes to | Registered via |
|---|---|---|
| Windows | `%LOCALAPPDATA%\firefox-mcp\` | `HKCU\Software\Mozilla\NativeMessagingHosts\firefox_mcp_bridge` |
| macOS | `~/Library/Application Support/firefox-mcp/` | `~/Library/Application Support/Mozilla/NativeMessagingHosts/` |
| Linux | `~/.local/share/firefox-mcp/` | `~/.mozilla/native-messaging-hosts/` (+ snap path) |

Other commands: `status`, `uninstall`, `version`, `help`.
From a source checkout: `npm install && npm run install-host` (uses Node instead
of the bundled binary).

### 2. Load the add-on

Development: `about:debugging#/runtime/this-firefox` → **Load Temporary
Add-on…** → pick `extension/manifest.json`. Permanent: see *Publishing* below.

### 3. Connect your harness

Toolbar icon → **Copy MCP config** (green dot = ready). The settings page
(toolbar icon → **Settings**) also has a Claude Code command and an opencode
snippet. The copied config looks like:

```json
{
  "mcpServers": {
    "firefox": {
      "type": "http",
      "url": "http://127.0.0.1:8901/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

Claude Code: `claude mcp add --transport http firefox http://127.0.0.1:8901/mcp --header "Authorization: Bearer <token>"`.
opencode: `{"mcp":{"firefox":{"type":"remote","url":"…/mcp","headers":{"Authorization":"Bearer <token>"}}}}`.
Clients that only speak stdio: `npx -y mcp-remote http://127.0.0.1:8901/mcp --header "Authorization: Bearer <token>"`.

Check from a shell:

```bash
curl http://127.0.0.1:8901/health
# {"ok":true,"extensionConnected":true,"version":"0.3.0"}
```

### Harness inside WSL, Firefox on Windows

WSL2 (default NAT networking) can't reach Windows' `127.0.0.1`. Easiest:

1. Add-on toolbar icon → **Settings** → **2. Connect your AI harness** → tick
   **Allow harnesses inside WSL to connect**.
2. Windows Firewall asks about `firefox-mcp-host` → tick **Private networks**
   → **Allow access**.
3. Same section → **Format** → **Claude Code inside WSL** → copy. It uses `$(ip route show default | awk '{print $3}')` for the Windows
   address, so it survives reboots.

The helper then also listens on the `vEthernet (WSL)` adapter only, not your
LAN. Alternative: WSL mirrored networking (`networkingMode=mirrored` under
`[wsl2]` in `%UserProfile%\.wslconfig`, then `wsl --shutdown`) makes
`127.0.0.1:8901` work from WSL as-is.

## AI cursor

Every tool accepts an optional `thought` argument (≤300 chars, e.g.
`"Opening the pricing page to compare plans"`). The add-on shows it in a
bubble beside an animated cursor on the page being driven:

- `act_*` tools: the cursor glides to the target element first, then clicks
  with a ripple. Without a `thought` it shows a default label
  ("Clicking “Sign in”", "Typing a password", …). Typed passwords are never
  echoed.
- Tab/navigation tools: the thought appears on the tab they affect.
- `cursor_note {note}`: just say something, no action.
- It is drawn in a closed shadow root with `pointer-events: none`, so it never
  blocks real input or leaks into `page_html` / `snapshot_ax`, and it is
  hidden while `screenshot` captures.
- It fades after 8s idle. Toggle: popup → **Show AI cursor**, or Settings →
  **AI cursor**. On by default.

The server's MCP `instructions` tell models to pass `thought`, so most
harnesses do it without prompting.

## Versions and updates

- Add-on and helper share one version (`package.json`, `manifest.json`,
  `shared/src/version.ts`), plus a separate wire `PROTOCOL` number that only
  changes on breaking bridge changes.
- On connect they exchange both. Same protocol, different version → the popup
  suggests updating the helper but keeps working. Different protocol → the
  popup says which side is too old and shows the fix (the install command, or
  "update the add-on").
- Re-running the installer while Firefox is open replaces the helper in
  place; the running helper notices, exits, and the add-on reconnects to the
  new one.
- 0.3.0 changed the add-on ID to `firefox-mcp@hamb1y.github.io`. If you had
  0.2.x, re-run the install command once so the helper accepts the new ID.

## Development

```bash
npm install
npm run build && npm run typecheck
node test/e2e.mjs                 # real background.js (mocked browser APIs) + real helper over native messaging and HTTP
MISSING=1 node test/e2e.mjs       # the "helper not installed" flow
node test/e2e.mjs dist/host/firefox-mcp-host-linux-x64   # same, against a compiled helper
npx web-ext@8 lint -s extension
```

Load `extension/manifest.json` as a temporary add-on and `npm run install-host`
to point Firefox at your checkout.

## Releasing

```bash
node scripts/set-version.mjs 0.3.1   # bumps package.json ×3, manifest.json, shared/src/version.ts
git commit -am "v0.3.1" && git tag v0.3.1 && git push --follow-tags
```

The tag triggers `.github/workflows/release.yml`: it checks the versions
match the tag, runs the tests, builds every helper with bun and publishes the
binaries, `install.sh`/`install.ps1`, `SHA256SUMS` and the add-on zip as a
GitHub release. Locally the same thing is `npm run release` (needs bun and an
authenticated `gh`); `npm run build:host` alone just builds
(`TARGETS="linux-x64"` for one). Installers use `releases/latest/download/…`,
so a new release is picked up without changing the add-on.

Single-file executables via `bun build --compile` (60–85 MB, no runtime
needed). They are **unsigned**: expect SmartScreen on Windows and Gatekeeper
on macOS (`xattr -c <file>` clears the quarantine flag; if macOS still
refuses, `codesign -s - -f <file>` gives it an ad-hoc signature).

## Tools

Tool names below match `registerTool(` in `mcp-server/src/tools/*.ts` exactly
(44 total). All except `extension_status`, `wait_for_tab_event` and
`cursor_note` take the optional `thought` described under *AI cursor*.

### Inventory / manage (`tabs.ts`, 19)

| Tool | What it does |
|---|---|
| `tabs_list` | List all open tabs (id, url, title, active/pinned/audible state). |
| `tabs_query` | Find tabs by URL/title pattern and state flags. |
| `active_tab` | Get the currently active tab (id, url, title, window). |
| `tab_create` | Open a new tab, optionally with a URL. |
| `tab_navigate` | Navigate a tab to a URL (defaults to the active tab). |
| `tab_close` | Close one or more tabs (destructive: needs `confirm:true`). |
| `tab_duplicate` | Duplicate a tab (defaults to the active tab). |
| `tab_move` | Move a tab to a new index, optionally to another window. |
| `tab_pin` | Pin a tab (defaults to the active tab). |
| `tab_unpin` | Unpin a tab (defaults to the active tab). |
| `tab_mute` | Mute or unmute a tab (defaults to the active tab). |
| `window_list` | List open Firefox windows (id, focused, tab count). |
| `window_create` | Open a new window, optionally with a URL. |
| `window_focus` | Bring a window to the front. |
| `window_close` | Close a window and all its tabs (destructive: needs `confirm:true`). |
| `nav_back` | Go back in a tab's history (defaults to the active tab). |
| `nav_forward` | Go forward in a tab's history (defaults to the active tab). |
| `nav_reload` | Reload a tab (defaults to the active tab). |
| `focus_tab` | Activate (focus) a tab by id. |

### Understand (`understand.ts`, 5)

| Tool | What it does |
|---|---|
| `snapshot_ax` | Accessibility snapshot of the page for grounding `act_*` refs (`[ref=N]` nodes). |
| `page_text` | Extract the visible text of the page. |
| `page_html` | Extract page HTML, optionally limited to a CSS selector subtree. |
| `screenshot` | Capture a screenshot of the tab's visible area (returned as an image). |
| `page_info` | Basic page metadata: URL, title, load state. |

### Act (`act.ts`, 9)

| Tool | What it does |
|---|---|
| `act_click` | Click an element by snapshot ref or CSS selector. |
| `act_type` | Type text into an element (focuses it first, optional Enter submit). |
| `act_fill_form` | Fill multiple form fields in one call (ref or selector each). |
| `act_select` | Select option(s) in a `<select>` element by value. |
| `act_hover` | Hover over an element (reveals tooltips, menus). |
| `act_scroll` | Scroll the page or an element (direction/pixels, or top/bottom). |
| `act_key` | Press a key, optionally with modifiers (e.g. `Enter`, `a` + Ctrl). |
| `act_wait` | Wait for text or a selector to appear (poll, `timeoutMs` default 10000 / max 60000). |
| `act_find` | Find text on the page (returns match locations/count). |

### Browser data (`browser.ts`, 8)

| Tool | What it does |
|---|---|
| `bookmarks_search` | Search bookmarks by title/URL query. |
| `bookmarks_create` | Create a bookmark. |
| `bookmarks_remove` | Delete a bookmark by id (destructive: needs `confirm:true`). |
| `history_search` | Search browsing history. |
| `downloads_list` | List recent downloads (filename, state, progress). |
| `cookies_for_tab` | Read cookies visible to a tab's page (read-only, no modification). |
| `sessions_recently_closed` | List recently closed tabs/windows available for restore. |
| `sessions_restore` | Restore a recently closed tab/window by session id. |

### Meta (`tools/index.ts`, 3)

| Tool | What it does |
|---|---|
| `extension_status` | Check whether the bridge extension is connected, plus profile details. |
| `wait_for_tab_event` | Wait for an extension-pushed event (`tab.updated/removed/activated`, `download.done`). |
| `cursor_note` | Show a note in the AI cursor bubble without doing anything. |

## Troubleshooting

- **Popup says "Helper app not installed".** The install step didn't run or
  wrote to a different place than this Firefox reads. Run the binary with
  `status` to see where it registered. Snap Firefox on Ubuntu reads
  `~/snap/firefox/common/.mozilla/native-messaging-hosts` (the installer
  writes there too); **Flatpak** Firefox cannot run native hosts without
  extra sandbox overrides — use the deb/tarball build (the installer warns when
it sees one). Then press **Retry**.
- **Popup says the helper is too old / the add-on is too old.** Run the
  install command again, or update the add-on, as the popup says.
- **Worked on 0.2.x, "not installed" on 0.3.0.** The add-on ID changed; run the
  install command once more.
- **"Port 8901 is already in use".** Another app, or this add-on in a second
  Firefox profile, holds it. Settings → Port → pick another → Save, then
  re-copy the MCP config.
- **401 unauthorized.** The token changed (Settings → New) — re-copy the config.
- **Temp add-on gone after restart.** Temporary add-ons unload when Firefox
  closes — reload via `about:debugging`, or install a signed `.xpi`. A
  temporary add-on keeps its token only while its ID stays the same (it does —
  the ID is fixed in `manifest.json`).
- **`RESTRICTED_PAGE`.** Content-script ops (`page.snapshot/text/html`, all
  `act.*`) are blocked on `about:*`, `chrome:*`, `resource:*`,
  `moz-extension:*`, `view-source:*`, `jar:`, `data:`/`blob:` pages and on
  `addons.mozilla.org` (Firefox forbids scripting there).
- **`act_wait` vs bridge timeout.** `act_wait` has its own `timeoutMs`
  (default 10000, max 60000); the helper extends its 30s watchdog to
  `timeoutMs + 15s` for that call.
- **Helper logs.** The helper writes to stderr, which Firefox shows in the
  Browser Console (Ctrl+Shift+J) prefixed `[firefox-mcp]`.

## Limits & safety

- **Local only by default.** The helper binds `127.0.0.1`; every MCP request
  needs the 256-bit bearer token, compared in constant time.
- **Confirm guard.** `tab_close`, `window_close`, `bookmarks_remove` refuse
  without explicit `confirm:true`.
- **No password-store access.** There is no tool for saved logins / the
  Firefox password manager. `cookies_for_tab` is read-only.
- **Screenshots are viewport-only.** `screenshot` captures the tab's visible
  area (`page.shot`), not the full scrollable page or OS chrome.

## Publishing the extension (AMO)

Two lanes, same upload flow at
[addons.mozilla.org/developers](https://addons.mozilla.org/developers/):

- **Unlisted (fast, self-distribution).** Automated checks only, signed in
  minutes. Install the resulting `.xpi` via Add-ons Manager → gear icon →
  Install Add-on From File. No public listing, no manual review. This is the
  right lane for personal use. AMO only signs the add-on — the helper
  binaries are shipped separately (e.g. GitHub releases).
- **Listed (public store page).** Full human review — expect days to weeks,
  and scrutiny proportional to permissions. This extension requests `tabs`,
  `bookmarks`, `history`, `cookies`, and `<all_urls>` content scripting, i.e.
  it can read and drive every page. A public listing will need a convincing
  justification: why full control is the product (AI browsing agent), why the
  data stays local (native helper on the same machine, token-gated), plus a
  privacy policy. Plan on review iterations.

Steps (both lanes):

1. `bash scripts/pack-extension.sh` → `firefox-mcp-bridge.zip`
   (manifest at zip root, `web-ext lint` clean).
2. Either upload the zip at
   [addons.mozilla.org/developers](https://addons.mozilla.org/developers/)
   → Submit a New Add-on, or sign from the CLI:
   `AMO_JWT_ISSUER=… AMO_JWT_SECRET=… bash scripts/amo-sign.sh`
   (get API keys at
   [AMO API keys](https://addons.mozilla.org/developers/addon/api/key/);
   default channel is `unlisted`, set `AMO_CHANNEL=listed` for a public
   listing).
3. Fill in the submission: pick **On your own** (unlisted) vs **On this
   site** (listed), declare the
   [`data_collection_permissions`](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/)
   already in `manifest.json` (`browsingActivity`, `websiteContent`,
   `websiteActivity`, `bookmarksInfo` — required because page content,
   URLs, interactions, and bookmarks flow to the local helper),
   and for listed also add icons (shipped in `extension/icons/`),
   description, and support info.
