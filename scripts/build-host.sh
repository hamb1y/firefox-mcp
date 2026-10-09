#!/usr/bin/env bash
# Build single-file webmcp-host binaries for every desktop platform.
# Output: dist/host/webmcp-host-<os>-<arch>[.exe]
set -euo pipefail
cd "$(dirname "$0")/.."

command -v bun >/dev/null 2>&1 || { echo "bun is required: https://bun.sh" >&2; exit 1; }

npm run build >/dev/null
# Start clean so nothing from an earlier or partial build ends up in SHA256SUMS or a release.
rm -rf dist/host
mkdir -p dist/host

sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }

TARGETS="${TARGETS:-windows-x64 windows-arm64 darwin-arm64 darwin-x64 linux-x64 linux-arm64}"
built=()
for t in $TARGETS; do
  ext=""; [[ $t == windows-* ]] && ext=".exe"
  name="webmcp-host-$t$ext"
  echo "→ dist/host/$name"
  bun build mcp-server/dist/host.js --compile --minify --target="bun-$t" --outfile "dist/host/$name" >/dev/null
  built+=("$name")
done

( cd dist/host && sha256 "${built[@]}" > SHA256SUMS )
ls -lh dist/host
