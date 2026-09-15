#!/usr/bin/env bash
# Boots a fresh local validator with stonkfolio-distributor loaded as an
# upgradeable program, plus Pyth-shaped SOL/USD price accounts, for
# `npm run test:distributor`. Run `anchor build` first.
#
# litesvm/solana-bankrun ship no Windows builds, so the distributor suite runs
# against a real validator with short windows and expiries instead of a
# warped clock.
set -euo pipefail
cd "$(dirname "$0")/.."

AUTHORITY=.keys/test-upgrade-authority.json
SO=target/deploy/stonkfolio_distributor.so
PROGRAM_ID=$(solana address -k target/deploy/stonkfolio_distributor-keypair.json)
PRICE_DIR=.keys/test-price-accounts

if [ ! -f "$SO" ]; then
  echo "$SO not found — run anchor build first" >&2
  exit 1
fi
mkdir -p .keys
[ -f "$AUTHORITY" ] || solana-keygen new --no-bip39-passphrase --silent -o "$AUTHORITY"

AUTHORITY_PUBKEY=$(solana address -k "$AUTHORITY")

# Price accounts are stamped with the current time, so regenerate them on every boot.
# DIST picks the compile output (e.g. DIST=dist-dev while a soak runs from dist/).
DIST=${DIST:-dist}
npx tsc -p tsconfig.json --outDir "$DIST"
rm -rf "$PRICE_DIR"
PRICE_ARGS=()
for pubkey in $(node "$DIST/scripts/make-test-price-accounts.js" "$PRICE_DIR"); do
  PRICE_ARGS+=(--account "$pubkey" "$PRICE_DIR/$pubkey.json")
done

# --mint funds the authority at genesis: the local faucet rejects airdrop
# requests on this machine, so tests don't rely on it.
exec solana-test-validator \
  --reset \
  --quiet \
  --ledger test-ledger \
  --mint "$AUTHORITY_PUBKEY" \
  --upgradeable-program "$PROGRAM_ID" "$SO" "$AUTHORITY_PUBKEY" \
  "${PRICE_ARGS[@]}"
