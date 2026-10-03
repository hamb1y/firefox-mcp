#!/usr/bin/env bash
# Sign the extension via AMO (addons.mozilla.org) using web-ext sign.
# Produces a signed .xpi for self-distribution WITHOUT a public listing.
#
# Required env vars (get them from https://addons.mozilla.org/developers/addon/api/key/):
#   AMO_JWT_ISSUER  - API key (JWT issuer)
#   AMO_JWT_SECRET  - API secret
#
# Optional:
#   AMO_CHANNEL     - "unlisted" (default: signed, not listed) or "listed"
#
# Usage:
#   AMO_JWT_ISSUER=... AMO_JWT_SECRET=... bash scripts/amo-sign.sh
set -euo pipefail

cd "$(dirname "$0")/.."

if [ -z "${AMO_JWT_ISSUER:-}" ] || [ -z "${AMO_JWT_SECRET:-}" ]; then
  echo "[webmcp] ERROR: set AMO_JWT_ISSUER and AMO_JWT_SECRET first." >&2
  echo "  Get them at: https://addons.mozilla.org/developers/addon/api/key/" >&2
  exit 1
fi

CHANNEL="${AMO_CHANNEL:-unlisted}"
if [ "$CHANNEL" != "unlisted" ] && [ "$CHANNEL" != "listed" ]; then
  echo "[webmcp] ERROR: AMO_CHANNEL must be 'unlisted' or 'listed'." >&2
  exit 1
fi

if ! command -v web-ext >/dev/null 2>&1; then
  echo "[webmcp] web-ext not found — installing locally via npx..."
fi

echo "[webmcp] linting extension..."
npx -y web-ext@8 lint -s extension

echo "[webmcp] signing (channel=$CHANNEL)..."
npx -y web-ext@8 sign \
  -s extension \
  --api-key="$AMO_JWT_ISSUER" \
  --api-secret="$AMO_JWT_SECRET" \
  --channel="$CHANNEL" \
  --timeout 300000

echo "[webmcp] done. Signed .xpi is under web-ext-artifacts/."
if [ "$CHANNEL" = "unlisted" ]; then
  echo "Install it via Firefox > Add-ons Manager > gear icon > Install Add-on From File."
fi
