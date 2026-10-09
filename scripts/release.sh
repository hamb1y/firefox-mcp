#!/usr/bin/env bash
# Build every helper binary + the extension zip and publish them as a GitHub release.
# Users then install with the one-liners in README / the add-on popup:
#   https://github.com/$REPO/releases/latest/download/<asset>
set -euo pipefail
cd "$(dirname "$0")/.."

REPO="${REPO:-hamb1y/webmcp-controller}"
TAG="v$(node -p 'require("./package.json").version')"
ALL_TARGETS="windows-x64 windows-arm64 darwin-arm64 darwin-x64 linux-x64 linux-arm64"

node scripts/set-version.mjs --check

sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }

# A release always carries every platform, built now, and nothing else: assemble an
# explicit list in a fresh staging directory and upload exactly that.
TARGETS="$ALL_TARGETS" bash scripts/build-host.sh
bash scripts/pack-extension.sh >/dev/null
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
ASSETS=()
for t in $ALL_TARGETS; do
  ext=""; [[ $t == windows-* ]] && ext=".exe"
  ASSETS+=("webmcp-host-$t$ext")
  cp "dist/host/webmcp-host-$t$ext" "$OUT/"
done
cp scripts/install.sh scripts/install.ps1 webmcp-controller.zip "$OUT/"
ASSETS+=(install.sh install.ps1 webmcp-controller.zip)
(cd "$OUT" && sha256 "${ASSETS[@]}" > SHA256SUMS)
ASSETS+=(SHA256SUMS)
FILES=()
for a in "${ASSETS[@]}"; do FILES+=("$OUT/$a"); done

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
  gh release upload "$TAG" --repo "$REPO" --clobber "${FILES[@]}"
else
  gh release create "$TAG" --repo "$REPO" --title "WebMCP Controller helper $TAG" --notes "$NOTES" "${FILES[@]}"
fi
echo "[webmcp] released $TAG → https://github.com/$REPO/releases/tag/$TAG"
