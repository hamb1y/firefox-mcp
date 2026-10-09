#!/usr/bin/env bash
# Package extension/ into webmcp-controller.zip for sideloading / AMO upload.
set -euo pipefail

cd "$(dirname "$0")/.."

OUT="webmcp-controller.zip"
rm -f "$OUT"

# Only what the add-on ships: never local files such as .amo-upload-uuid or README-INSTALL.md.
# Paths are RELATIVE to extension/ so AMO sees manifest.json at the root.
python3 - "$OUT" <<'EOF2'
import os, sys, zipfile
out = sys.argv[1]
SHIP = ["manifest.json", "background.js", "common.js", "ui.css", "popup.html", "popup.js",
        "options.html", "options.js", "content", "icons", "fonts", "cursors"]
files = []
for entry in SHIP:
    full = os.path.join("extension", entry)
    if os.path.isfile(full):
        files.append(full)
    elif os.path.isdir(full):
        for dirpath, dirs, names in os.walk(full):
            dirs[:] = sorted(d for d in dirs if not d.startswith("."))
            files += [os.path.join(dirpath, n) for n in sorted(names) if not n.startswith(".")]
    elif entry in ("manifest.json", "background.js"):
        sys.exit(f"missing extension/{entry}")
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for f in files:
        z.write(f, os.path.relpath(f, "extension"))
print(f"wrote {out} ({len(files)} files)")
EOF2

echo "[webmcp] contents:"
unzip -l "$OUT" 2>/dev/null || python3 -c "import zipfile,sys; print('\n'.join(zipfile.ZipFile(sys.argv[1]).namelist()))" "$OUT"

echo "[webmcp] packed $OUT"
echo "Next steps:"
echo "  - Temporary install: Firefox > about:debugging > Load Temporary Add-on > extension/manifest.json"
echo "  - AMO signing: submit $OUT at https://addons.mozilla.org/developers/ to get a signed .xpi"
echo "    (unlisted signing works for self-distribution; listed review is required for public listing)."
echo "  - The add-on needs the helper app: npm run build:host -> dist/host/, or npm run install-host on this machine."
