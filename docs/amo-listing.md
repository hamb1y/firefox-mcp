# AMO listing: paste-ready text

## Name
Firefox MCP Bridge

## Add-on URL (slug)
firefox-mcp-bridge

## Summary (max 250 chars)
Let your own AI agent (Claude Code, opencode, Cursor, any MCP client) read and drive this Firefox over MCP, with a live AI cursor showing what it's doing. Everything stays on your computer. Needs a small free companion helper app.

## Description
Firefox MCP Bridge connects the Firefox you already use (your tabs, logins and bookmarks) to an AI agent running on your own computer, through the Model Context Protocol (MCP).

What the agent can do:
• List, open, switch, move and close tabs and windows
• Read pages (accessibility snapshot, text, HTML, screenshots)
• Click, type, fill forms, scroll, press keys and wait for content
• Search bookmarks and history, list downloads, restore closed tabs

While it works, a glowing AI cursor glides to whatever it's clicking, with a small bubble saying what it's doing. You can turn it off in the popup.

How it works: Firefox add-ons can't open network ports, so the add-on starts a small companion helper app through Firefox native messaging. The helper serves MCP only on 127.0.0.1 (this computer), and every request needs a random secret token that the add-on generates. Nothing is sent to the developer or any third party. Your AI tool talks to the helper, and the helper talks to this add-on.

Setup (about a minute):
1. Install this add-on.
2. Click its toolbar icon. It shows a one-line command for your system that installs the helper app (Windows, macOS, Linux). Paste it into PowerShell or Terminal.
3. Click "Copy MCP config" and paste it into your AI tool.

Safety:
• Local only by default; token-protected
• Closing tabs or windows and deleting bookmarks need explicit confirmation
• No access to saved passwords; cookies are read-only

Source code for the add-on and the helper (MIT): https://github.com/hamb1y/firefox-mcp

## Categories
Firefox: "Tabs" and "Other"

## Support
Website: https://github.com/hamb1y/firefox-mcp/issues

## License
MIT License

## Privacy policy
Firefox MCP Bridge does not collect, store or send any data to the developer or to any third party, and contains no analytics or tracking.

The add-on exchanges data only with the companion helper app on your own computer, through Firefox native messaging. The helper makes that data available only to programs you connect to it on your computer (by default it listens on 127.0.0.1 and requires a secret token that the add-on generates). That data can include tab URLs and titles, page content, screenshots, bookmarks, history, downloads and cookies for a tab. The helper sends data only when one of those programs asks for it.

If you connect an AI tool that uses a cloud service, that tool may send what it reads to its provider under that provider's own privacy policy. That's outside this add-on's control.

Settings (port, token, toggles) are stored locally in Firefox extension storage. Uninstalling the add-on removes them.

## Notes to reviewer
This add-on uses native messaging with an open-source companion helper app, like KeePassXC-Browser or 1Password do. The add-on's JavaScript is not minified or bundled; no build step.

Helper source: https://github.com/hamb1y/firefox-mcp/tree/main/mcp-server (TypeScript, compiled to single-file binaries with `bun build --compile`). Release binaries and SHA256SUMS are at https://github.com/hamb1y/firefox-mcp/releases/latest

To test:
1. Install the add-on, then install the helper:
   Linux/macOS: curl -fsSL https://github.com/hamb1y/firefox-mcp/releases/latest/download/install.sh | sh
   Windows (PowerShell or cmd): powershell -ExecutionPolicy Bypass -c "irm https://github.com/hamb1y/firefox-mcp/releases/latest/download/install.ps1 | iex"
2. Click the toolbar icon. The dot turns green, then click "Copy MCP config" (contains URL + token).
3. From a terminal (replace TOKEN):
   curl -s http://127.0.0.1:8901/mcp -H "Authorization: Bearer TOKEN" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"tabs_list","arguments":{"thought":"Listing tabs"}}}'
   The open tabs are returned, and the AI cursor shows "Listing tabs" on the active page.

Why each permission:
• tabs, <all_urls>, content scripts: read and interact with pages at the user's agent's request; draw the AI cursor
• nativeMessaging: talk to the local helper that serves MCP
• bookmarks, history, downloads, sessions: the corresponding agent tools
• cookies: read-only cookies_for_tab tool
• storage: settings and token
