#!/usr/bin/env bash
# Build every helper binary + the extension zip and publish them as a GitHub release.
# Users then install with the one-liners in README / the add-on popup:
#   https://github.com/$REPO/releases/latest/download/<asset>
set -euo pipefail
cd "$(dirname "$0")/.."

REPO="${REPO:-hamb1y/firefox-mcp}"
TAG="v$(node -p 'require("./package.json").version')"
OUT=dist/host

node scripts/set-version.mjs --check

bash scripts/build-host.sh
bash scripts/pack-extension.sh >/dev/null
cp scripts/install.sh scripts/install.ps1 "$OUT/"
cp firefox-mcp-bridge.zip "$OUT/"
(cd "$OUT" && rm -f SHA256SUMS && sha256sum firefox-mcp-host-* install.sh install.ps1 firefox-mcp-bridge.zip > SHA256SUMS)

NOTES="$(cat <<MD
Helper app for the **WebMCP Controller** add-on.

**Windows** — open PowerShell or Command Prompt and paste:
\`\`\`bat
powershell -ExecutionPolicy Bypass -c "irm https://github.com/$REPO/releases/latest/download/install.ps1 | iex"
\`\`\`

**macOS / Linux** — open Terminal and paste:
\`\`\`sh
curl -fsSL https://github.com/$REPO/releases/latest/download/install.sh | sh
\`\`\`

Already installed? Run the same command again to update: Firefox switches to the
new helper by itself within a few seconds.

Then click **Retry** in the add-on popup. Manual: download the file for your
system below and run it with \`install\` (Windows: double-click the .exe).
MD
)"

if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  gh release upload "$TAG" --repo "$REPO" --clobber "$OUT"/*
else
  gh release create "$TAG" --repo "$REPO" --title "WebMCP Controller helper $TAG" --notes "$NOTES" "$OUT"/*
fi
echo "[firefox-mcp] released $TAG → https://github.com/$REPO/releases/tag/$TAG"
