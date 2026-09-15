#!/usr/bin/env bash
# Devnet soak: runs the rehearsal keeper (scripts/devnet-rehearsal.ts, soak mode) for hours at a slower
# snapshot cadence and hard-kills it at random moments, restarting it each time, to show it resumes from
# its state without double-paying or stalling. Every finished round is still verified on-chain.
#
#   scripts/devnet-soak.sh <hours> <work dir> <deployment.json> <file holding the devnet RPC URL> [holders RPC]
#
# Environment: SNAPSHOT_SECS (default 900), KILL_MIN_SECS / KILL_MAX_SECS (default 1.5 h / 4 h).
# Output goes to <work dir>/soak.log; lines from this wrapper start with "SOAK".
set -uo pipefail

HOURS=$1
WORK=$2
DEPLOYMENT=$3
RPC_FILE=$4
HOLDERS_RPC=${5:-https://api.devnet.solana.com}
SNAPSHOT_SECS=${SNAPSHOT_SECS:-900}
KILL_MIN_SECS=${KILL_MIN_SECS:-5400}
KILL_MAX_SECS=${KILL_MAX_SECS:-14400}

cd "$(dirname "$0")/.."
mkdir -p "$WORK"
LOG="$WORK/soak.log"
END_SECS=$(( $(date +%s) + HOURS * 3600 ))

say() { echo "$(date -u +%Y-%m-%dT%H:%M:%S.000Z) SOAK $*" >> "$LOG"; }
# Keeps provider API keys out of the log.
mask() { sed -uE 's#https?://[^ ]*(alchemy|helius)[^ ]*#<rpc>#g'; }

kills=0
crashes=0
say "starting a ${HOURS} h soak (snapshots every ~${SNAPSHOT_SECS} s, hard kills every $((KILL_MIN_SECS / 60))-$((KILL_MAX_SECS / 60)) min)"
while (( $(date +%s) < END_SECS )); do
  node dist/scripts/devnet-rehearsal.js --deployment "$DEPLOYMENT" --keeper .keys/keeper-devnet.json --work "$WORK" \
    --until "$(( END_SECS * 1000 ))" --snapshot-secs "$SNAPSHOT_SECS" --rpc "$(cat "$RPC_FILE")" --holders-rpc "$HOLDERS_RPC" \
    > >(mask >> "$LOG") 2>&1 &
  pid=$!
  sleep 2
  winpid=$(cat "/proc/$pid/winpid" 2>/dev/null || echo "$pid")
  kill_at=$(( $(date +%s) + KILL_MIN_SECS + RANDOM % (KILL_MAX_SECS - KILL_MIN_SECS + 1) ))
  # FIRST_KILL_SECS brings the first kill forward, to see a restart early in a long soak.
  if (( kills + crashes == 0 )) && [[ -n ${FIRST_KILL_SECS:-} ]]; then kill_at=$(( $(date +%s) + FIRST_KILL_SECS )); fi
  say "keeper started (pid $winpid); hard kill planned for $(date -u -d "@$kill_at" +%H:%M:%SZ)"

  killed=0
  while kill -0 "$pid" 2>/dev/null; do
    # no kill in the last 10 minutes, so the final run can finish and print its summary
    if (( $(date +%s) >= kill_at && $(date +%s) < END_SECS - 600 )); then
      taskkill //F //PID "$winpid" > /dev/null 2>&1 || kill -9 "$pid"
      killed=1
      kills=$((kills + 1))
      say "hard-killed the keeper mid-run (kill #$kills)"
      break
    fi
    sleep 20
  done
  wait "$pid"
  code=$?

  if (( killed == 0 )); then
    if (( code == 0 )); then
      say "keeper finished normally"
      break
    fi
    crashes=$((crashes + 1))
    say "keeper exited on its own with code $code (unplanned exit #$crashes)"
    if tail -n 30 "$LOG" | grep -q "STOP:"; then
      say "stop condition reached; ending the soak"
      break
    fi
  fi
  sleep 30
done
say "done: $kills hard kill(s), $crashes unplanned exit(s)"
