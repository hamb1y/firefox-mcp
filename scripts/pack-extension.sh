#!/usr/bin/env bash
# Package extension/ into firefox-mcp-bridge.zip for sideloading / AMO upload.
set -euo pipefail

cd "$(dirname "$0")/.."

OUT="firefox-mcp-bridge.zip"
rm -f "$OUT"

# Zip with paths RELATIVE to extension/ so AMO sees manifest.json at the root.
if command -v zip >/dev/null 2>&1; then
  (cd extension && zip -r "../$OUT" . -x README-INSTALL.md)
else
  python3 - "$OUT" <<'EOF'
import os, sys, zipfile
out = sys.argv[1]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for dirpath, _dirs, files in os.walk("extension"):
        for f in files:
            if f == "README-INSTALL.md":
                continue
            full = os.path.join(dirpath, f)
            z.write(full, os.path.relpath(full, "extension"))
print(f"wrote {out}")
EOF
fi

echo "[firefox-mcp] contents:"
unzip -l "$OUT" 2>/dev/null || python3 -c "import zipfile,sys; print('\n'.join(zipfile.ZipFile(sys.argv[1]).namelist()))" "$OUT"

echo "[firefox-mcp] packed $OUT"
echo "Next steps:"
echo "  - Temporary install: Firefox > about:debugging > Load Temporary Add-on > extension/manifest.json"
echo "  - AMO signing: submit $OUT at https://addons.mozilla.org/developers/ to get a signed .xpi"
echo "    (unlisted signing works for self-distribution; listed review is required for public listing)."
echo "  - The add-on needs the helper app: npm run build:host -> dist/host/, or npm run install-host on this machine."
