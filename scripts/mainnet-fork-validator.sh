#!/usr/bin/env bash
# Boots a local solana-test-validator forked from mainnet-beta for the
# lifecycle proof (tests-manual/lifecycle-fork.ts):
#   - Meteora DBC and DAMM v2, cloned as upgradeable programs exactly as deployed
#   - Metaplex token metadata (DBC pool creation CPIs into it)
#   - DAMM v2's Customizable migration config and the wSOL mint
#   - the top StonkFun-graduated mints, as basket stand-ins
#   - our freshly built stonkfolio-distributor
#
# Cloning only reads mainnet accounts; nothing is signed or sent to mainnet.
# Jupiter routing still can't be tested here (it's a hosted mainnet API).
#
# Usage: ./scripts/mainnet-fork-validator.sh [basket-mint-limit]
set -euo pipefail
cd "$(dirname "$0")/.."

LIMIT="${1:-30}"
MAINNET_RPC_URL="${MAINNET_RPC_URL:-https://api.mainnet-beta.solana.com}"
AUTHORITY=.keys/test-upgrade-authority.json
SO=target/deploy/stonkfolio_distributor.so

DBC_PROGRAM=dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN
DAMM_V2_PROGRAM=cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG
METAPLEX_METADATA_PROGRAM=metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s
DAMM_V2_CUSTOMIZABLE_CONFIG=A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck
WSOL_MINT=So11111111111111111111111111111111111111112
# Data-less system accounts that Meteora keeps funded on mainnet: migration
# pays DAMM v2 pool and position rent from them. Without cloning their
# lamports, migration fails on the fork with "insufficient lamports".
DBC_POOL_AUTHORITY=FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM
DAMM_V2_POOL_AUTHORITY=HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC
# Pyth's SOL/USD price account: the distributor reads it on-chain when a
# round's window closes, for the $50 eligibility check.
PYTH_SOL_USD=7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE

if [ ! -f "$SO" ]; then
  echo "$SO not found — run anchor build first" >&2
  exit 1
fi
mkdir -p .keys
[ -f "$AUTHORITY" ] || solana-keygen new --no-bip39-passphrase --silent -o "$AUTHORITY"
AUTHORITY_PUBKEY=$(solana address -k "$AUTHORITY")
PROGRAM_ID=$(solana address -k target/deploy/stonkfolio_distributor-keypair.json)

echo "Building..."
npx tsc -p tsconfig.json

# --maybe-clone (not --clone): a mint from StonkFun's live API is dynamic,
# third-party data — skip one that turns out to be unreadable rather than
# failing the whole boot over a single bad candidate.
CLONE_ARGS=()
echo "Fetching top $LIMIT real StonkFun-graduated mints..."
if MINTS=$(node dist/scripts/fetch-graduated-mints.js "$LIMIT"); then
  while IFS= read -r mint; do
    [ -n "$mint" ] && CLONE_ARGS+=(--maybe-clone "$mint")
  done <<< "$MINTS"
else
  echo "fetch-graduated-mints failed — continuing without basket mints" >&2
fi

echo "Starting forked validator against $MAINNET_RPC_URL..."
# --mint funds the test authority at genesis; the local faucet is unreliable
# on this machine.
exec solana-test-validator \
  --reset \
  --quiet \
  --ledger test-ledger-fork \
  --limit-ledger-size 10000000 \
  --url "$MAINNET_RPC_URL" \
  --mint "$AUTHORITY_PUBKEY" \
  --clone-upgradeable-program "$DBC_PROGRAM" \
  --clone-upgradeable-program "$DAMM_V2_PROGRAM" \
  --clone-upgradeable-program "$METAPLEX_METADATA_PROGRAM" \
  --clone "$DAMM_V2_CUSTOMIZABLE_CONFIG" \
  --maybe-clone "$WSOL_MINT" \
  --clone "$DBC_POOL_AUTHORITY" \
  --clone "$DAMM_V2_POOL_AUTHORITY" \
  --clone "$PYTH_SOL_USD" \
  --upgradeable-program "$PROGRAM_ID" "$SO" "$AUTHORITY_PUBKEY" \
  "${CLONE_ARGS[@]}"
