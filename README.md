# Firefox MCP Bridge — helper app

The Firefox MCP Bridge add-on lets your own AI tool (Claude, opencode, Cursor, …)
read and drive your Firefox. It needs this small helper app; Firefox starts it automatically.

## Install

**Windows** — open PowerShell and paste:

```powershell
irm https://github.com/hamb1y/firefox-mcp/releases/latest/download/install.ps1 | iex
```

**macOS / Linux** — open Terminal and paste:

```sh
curl -fsSL https://github.com/hamb1y/firefox-mcp/releases/latest/download/install.sh | sh
```

Then click the add-on's toolbar icon → **Copy MCP config** and paste it into your AI tool.

Prefer clicking? Download the file for your system from the
[latest release](https://github.com/hamb1y/firefox-mcp/releases/latest):
on Windows double-click the `.exe`; on macOS/Linux run `chmod +x <file> && ./<file> install`.

Uninstall: run the installed app with `uninstall`
(`%LOCALAPPDATA%\firefox-mcp\firefox-mcp-host.exe`, `~/Library/Application Support/firefox-mcp/firefox-mcp-host`,
or `~/.local/share/firefox-mcp/firefox-mcp-host`).
