#!/usr/bin/env bash
# Build single-file webmcp-host binaries for every desktop platform.
# Output: dist/host/webmcp-host-<os>-<arch>[.exe]
set -euo pipefail
cd "$(dirname "$0")/.."

command -v bun >/dev/null 2>&1 || { echo "bun is required: https://bun.sh" >&2; exit 1; }

npm run build >/dev/null
mkdir -p dist/host

TARGETS="${TARGETS:-windows-x64 windows-arm64 darwin-arm64 darwin-x64 linux-x64 linux-arm64}"
for t in $TARGETS; do
  ext=""; [[ $t == windows-* ]] && ext=".exe"
  out="dist/host/webmcp-host-$t$ext"
  echo "→ $out"
  bun build mcp-server/dist/host.js --compile --minify --target="bun-$t" --outfile "$out" >/dev/null
done

( cd dist/host && sha256sum webmcp-host-* > SHA256SUMS )
ls -lh dist/host
