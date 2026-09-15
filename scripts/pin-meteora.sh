#!/usr/bin/env bash
# Pins the exact Meteora programs and migration config our launch was tested against.
#
#   ./scripts/pin-meteora.sh          # compare mainnet against deployments/meteora-programs.json
#   ./scripts/pin-meteora.sh --update # record the current mainnet state as the pin
#
# Meteora's programs are upgradeable, and the DAMM v2 migration config can be
# changed by its operators. If any of these change after our fork tests
# passed, launch behavior is no longer proven — this exits non-zero so the
# launch runbook stops until the lifecycle test is re-run and the pin
# refreshed. The running keeper checks the same pin every hour
# (keeper/monitor.ts). Only reads from mainnet.
set -euo pipefail
cd "$(dirname "$0")/.."

MAINNET_RPC_URL="${MAINNET_RPC_URL:-https://api.mainnet-beta.solana.com}"
PIN_FILE=deployments/meteora-programs.json
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

declare -A PROGRAMS=(
  [dynamic_bonding_curve]=dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN
  [damm_v2]=cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG
)
DAMM_V2_CUSTOMIZABLE_CONFIG=A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck

entries=()
for name in dynamic_bonding_curve damm_v2; do
  id=${PROGRAMS[$name]}
  solana program dump --url "$MAINNET_RPC_URL" "$id" "$WORK/$name.so" >/dev/null
  hash=$(sha256sum "$WORK/$name.so" | cut -d' ' -f1)
  show=$(solana program show --url "$MAINNET_RPC_URL" "$id")
  slot=$(echo "$show" | awk -F': ' '/Last Deployed In Slot/ {print $2}')
  authority=$(echo "$show" | awk -F': ' '/^Authority/ {print $2}')
  [ "$authority" = "none" ] && authority_json=null || authority_json="\"$authority\""
  echo "$name $id sha256=$hash last_deployed_slot=$slot authority=$authority"
  entries+=("\"$name\": {\"programId\": \"$id\", \"sha256\": \"$hash\", \"lastDeployedSlot\": $slot, \"upgradeAuthority\": $authority_json}")
done

config_hash=$(solana account --url "$MAINNET_RPC_URL" --output json "$DAMM_V2_CUSTOMIZABLE_CONFIG" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s).account;process.stdout.write(require("crypto").createHash("sha256").update(Buffer.from(a.data[0],"base64")).digest("hex"))})')
echo "damm_v2_customizable_config $DAMM_V2_CUSTOMIZABLE_CONFIG sha256=$config_hash"
entries+=("\"damm_v2_customizable_config\": {\"address\": \"$DAMM_V2_CUSTOMIZABLE_CONFIG\", \"sha256\": \"$config_hash\"}")
current="{$(IFS=,; echo "${entries[*]}")}"

if [ "${1:-}" = "--update" ]; then
  mkdir -p "$(dirname "$PIN_FILE")"
  echo "$current" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify(JSON.parse(s),null,2)+"\n"))' > "$PIN_FILE"
  echo "pinned to $PIN_FILE"
  exit 0
fi

if [ ! -f "$PIN_FILE" ]; then
  echo "no pin file — run with --update after the lifecycle test passes" >&2
  exit 1
fi
node -e '
  const pinned = JSON.parse(require("fs").readFileSync(process.argv[1], "utf-8"));
  const current = JSON.parse(process.argv[2]);
  let changed = 0;
  const report = (message) => { console.error(`CHANGED: ${message}`); changed++; };
  for (const [name, now] of Object.entries(current)) {
    const pin = pinned[name];
    if (!pin) { console.warn(`NOT PINNED: ${name} — refresh the pin with --update once the lifecycle test passes`); continue; }
    if (pin.sha256 !== now.sha256) report(`${name} no longer matches the pinned ${now.programId ? "binary" : "account data"}`);
    if (now.programId) {
      if (pin.lastDeployedSlot !== now.lastDeployedSlot) report(`${name} was redeployed at slot ${now.lastDeployedSlot} (pinned ${pin.lastDeployedSlot})`);
      if (pin.upgradeAuthority === undefined) console.warn(`NOT PINNED: ${name} upgrade authority (now ${now.upgradeAuthority})`);
      else if (pin.upgradeAuthority !== now.upgradeAuthority) report(`${name} upgrade authority is ${now.upgradeAuthority} (pinned ${pin.upgradeAuthority})`);
    }
  }
  if (changed) process.exit(1);
  console.log("Meteora programs and migration config match the pin");
' "$PIN_FILE" "$current"
