# Stonkfolio operations runbook

After launch nothing here is a routine manual step. The keeper runs every coin on its own. This runbook covers:

- the one-time launch sequence
- what to watch while it runs
- what to do when something outside our control goes wrong

## What depends on what

| Piece | Who controls it | If it fails |
|---|---|---|
| `stonkfolio-distributor` program | Nobody, once its upgrade authority is revoked | — |
| Keeper key | The server running the keeper. It is the fee claimer, pool creator, and each distributor's root authority. | Fees stop being claimed and rounds stop. Holders can still self-claim committed rounds until expiry. |
| Meteora DBC and DAMM v2 | Meteora (upgradeable) | Checked by `scripts/pin-meteora.sh` before launch. Meteora can also change pool fees or pause pools. |
| Migration rent | Meteora-funded pool-authority PDAs | Migration stalls until Meteora refills them. Swaps stay halted at 85 SOL meanwhile. |
| Holder snapshots | Helius DAS | Snapshots pause. Rounds wait; nothing is lost. |
| SOL/USD | Pyth price account, read by the distributor program when a round's window closes | Stale or wide prices keep the window open; it closes on a later tick. |
| Round seed | The SlotHashes sysvar, read by the distributor program | If the seed isn't recorded within ~3 minutes of its block, nothing is bought. The program only lets the round be abandoned 24 hours after its window closed, so that coin's rounds pause for up to a day. Each such abandon is counted on-chain (`expired_seed_abandons`). |
| Basket buys | Jupiter API and StonkFun API | Purchases retry or skip individual coins. The swap guard rejects any transaction that doesn't behave as quoted. |
| Artifact publishing | Git remote (or a served directory) | Rounds won't commit until the bundle publishes. |

## Launch (one time)

1. **Build and test.**
   ```bash
   anchor build && npm test
   ```
   Then run the distributor suite and the fork lifecycle:
   ```bash
   npm run test:distributor
   ```
   ```bash
   npm run test:mainnet-fork
   ```
2. **Build the program reproducibly** from the audited (or fix-reviewed) commit. Deploy this `.so`, never one from `anchor build` or `cargo build-sbf`: those depend on the local toolchain and paths, so their hashes won't match.
   ```bash
   bash scripts/verifiable-build.sh <COMMIT>
   ```
   - The script builds inside the Solana Foundation's verifiable-build image, pinned by digest, from a clean checkout. It is the same build `solana-verify build --library-name stonkfolio_distributor` runs.
   - It prints the **executable hash**. Run it twice and confirm both hashes match.
   - It needs Docker and about 6 GB free.
3. **Deploy the distributor program** to mainnet from a fresh keypair, using `.verifiable-build/src/target/deploy/stonkfolio_distributor.so`. Then confirm the on-chain program is exactly that build.
   ```bash
   solana-verify get-program-hash -u <RPC> <PROGRAM_ID>
   ```
   The result must equal the executable hash from step 2. `solana-verify` doesn't compile on Windows. Without it, dump the program and hash it the same way: sha256 with trailing zero bytes stripped.
   ```bash
   solana program dump -u <RPC> <PROGRAM_ID> deployed.so && node -e 'const b=require("fs").readFileSync("deployed.so");let n=b.length;while(n>0&&b[n-1]===0)n--;console.log(require("crypto").createHash("sha256").update(b.subarray(0,n)).digest("hex"))'
   ```
   Record the program id, commit and executable hash.

   **Upgrading an existing deployment** (only possible before revocation). The program account is sized for the build it holds, so a larger `.so` needs room first. The loader refuses extensions smaller than 10,240 bytes, so extend by the larger of what's needed and 10,240:
   ```bash
   solana program extend <PROGRAM_ID> <max(new .so bytes - current data length, 10240)> -u <RPC>
   ```
   Then deploy with `--program-id <PROGRAM_ID> --upgrade-authority <keypair>`.
   - Don't trust command output alone. Confirm `solana program show` reports a `Data Length` at least the `.so` size, and that `Last Deployed In Slot` changed.
   - Then re-check the executable hash as above.
4. **Publish verification before revoking.** Put the source at that commit in a public repository, then upload the verification data while the upgrade authority can still sign. Explorers will then show the program as verified.
   ```bash
   solana-verify verify-from-repo -u <RPC> --program-id <PROGRAM_ID> https://github.com/<REPO> --commit-hash <COMMIT> --library-name stonkfolio_distributor --mount-path .
   ```
   ```bash
   solana-verify remote submit-job --program-id <PROGRAM_ID> --uploader <UPGRADE_AUTHORITY>
   ```
   After revocation, OtterSec has to whitelist the upload (contact@osec.io).
5. **Keep the upgrade authority for now.** It is revoked 7 days after launch (step 12), so a problem found in live use can still be fixed. Keep the deployer key offline and encrypted until then, and say publicly that the team holds it until that date.
6. **Confirm Meteora is unchanged since the fork test.**
   ```bash
   bash scripts/pin-meteora.sh
   ```
7. **Create a dedicated keeper key.** Fund it with a small operating float: pool creation, the first transactions, and ~2 SOL of migration rent that is refunded. Round costs after that come out of each coin's fees.
8. **Create the fee tier configs** and check every field on-chain.
   ```bash
   node dist/scripts/launch/create-fee-tier-configs.js --rpc <RPC> --payer <keeper.json> --fee-claimer <KEEPER_PUBKEY> --out deployments/mainnet.json --cluster mainnet
   ```
   ```bash
   node dist/scripts/launch/verify-config.js --rpc <RPC> --deployment deployments/mainnet.json
   ```
9. **Launch $FOLIO.** It must be the first pool, and its symbol must be `FOLIO` (`PLATFORM_TOKEN_SYMBOL` in `keeper/config.ts`), because the platform buyback targets it. `create-pool` refuses any other symbol for the first pool.
   ```bash
   node dist/scripts/launch/create-pool.js --rpc <RPC> --creator <keeper.json> --deployment deployments/mainnet.json --fee-bps 500 --name Stonkfolio --symbol FOLIO --uri <METADATA_URI>
   ```
10. **Fill in `/etc/stonkfolio/keeper.env`** from `deploy/keeper.env.example`, then install and start `deploy/stonkfolio-keeper.service`.
11. **Publish the key addresses:** program id, commit and executable hash, deployment file, keeper address, artifacts repository, and the date the upgrade authority will be revoked.
12. **Seven days after launch, revoke the program's upgrade authority.** First re-check the executable hash (step 3) and confirm verification is published (step 4). From then on the payout rules are final.
   ```bash
   solana program set-upgrade-authority <PROGRAM_ID> --final --upgrade-authority <DEPLOYER_KEYPAIR> -u <RPC>
   ```
   Confirm `solana program show <PROGRAM_ID>` reports `Authority: none`, then publish the transaction.

## While it runs

- **Logs:** `journalctl -u stonkfolio-keeper.service -f`. Each coin logs fee claims with their bucket split, buybacks, liquidity adds, and every round step.
- **Per-coin state:** `$STONKFOLIO_STATE_DIR/<pool>/state.json`. It holds:
  - the ledger buckets
  - the coin's basket inventory (tokens the shared keeper wallet holds for this coin)
  - the collecting round and any rounds still paying out
  - rounds awaiting expiry
  - journaled transactions not yet confirmed
- **Ledger check:** the keeper wallet's SOL should be at least the sum of every coin's ledger buckets.
  - Every SOL movement is journaled before it's sent and applied only once it lands, so timeouts don't open gaps.
  - Each round's cost reserve is settled against its actual spend when the round finishes.
- **Basket buys** each run from a new throwaway wallet funded with just that buy's SOL, then swept back. A `waiting: funding of the swap wallet…` line clears once the funding transaction confirms or expires.
- **Lock:** `$STONKFOLIO_STATE_DIR/keeper.lock` names the running process. A second keeper on the same state refuses to start.
- **Stopping:** `systemctl stop` sends SIGTERM. The keeper finishes its current step, then exits.
- **Back up the state directory.** It holds each open round's sampling secret, which exists nowhere else until the round commits.
- **Round bundles** appear in the artifacts repository before each commit. Anyone can check one:
  ```bash
  npm run verify-round -- <bundle dir> --rpc <RPC>
  ```
  - With `--rpc`, the bundle is also checked against the distributor's fixed policy, the round's on-chain intent (window, snapshot chain head, SOL/USD price, seed), the committed roots, and the basket purchase transactions.
  - Snapshot balances and the pool price remain keeper-attested. Spot-check them against an archive RPC.

## When something goes wrong

**The curve reached 85 SOL but didn't migrate.**
- The keeper migrates on its next tick; migration is permissionless.
- If ticks are failing, check the logs.
- If Meteora's pool-authority PDAs are empty, migration can't proceed until Meteora refills them. Anyone can then migrate, including through Meteora's own migrator.

**A holder says they weren't paid.**
- Look for them in `<state dir>/rounds/<id>/payout-failures.json`.
- Permanent failures are left for self-claim until the round expires. There are two kinds:
  - Undeliverable accounts: memo-required or frozen.
  - Small first-time payouts: worth less than 3× the rent of the token account they'd need, so the holder self-claims and pays that rent.
- The holder self-claims with:
  ```bash
  node dist/scripts/self-claim.js --rpc <RPC> --bundle <bundle dir> --keypair <their wallet.json> --fresh-accounts true
  ```

**The keeper key is exposed.**
- **Distributor authority:** rotate each coin's distributor root authority to a new keeper key (`propose_root_authority` from the old key, then `accept_root_authority` from the new one).
  - Distributor addresses derive from the key that created them. Set `STONKFOLIO_DISTRIBUTOR_CREATOR` to the old key so the new keeper finds them.
  - The keeper still refuses to start if its key isn't the deployment's fee claimer, so a rotated key can run rounds only from a build that relaxes that check.
- **Fee claimer:** DBC's fee claimer can't be changed, so the old key keeps curve-fee rights and holds the locked position NFTs.
  - The permanently locked liquidity itself can never be withdrawn by anyone.
  - Assume that coin's future pool fees are at risk, and say so publicly.
- **Operating float:** move any SOL float out of the old key.

**`pin-meteora.sh` or the keeper log reports `ALERT: Meteora …`.**
- **What it means:** one of these changed since the fork lifecycle test last passed:
  - a Meteora program binary, its deploy slot, or its upgrade authority
  - the DAMM v2 migration config
- **Response:**
  1. Stop new launches.
  2. Tell holders.
  3. Rerun the fork lifecycle against the current mainnet state.
  4. Refresh the pin with `bash scripts/pin-meteora.sh --update` once it passes, and restart the keeper.
- **Already-launched coins:** the keeper keeps running. It has no power over Meteora, so nothing here is a switch to flip.

**The keeper log reports `ALERT: DAMM v2 pool … changed outside our control`.**
- Meteora's operators can change a graduated pool's fee or pause its swaps without upgrading anything. The keeper records both every tick and alerts on any change.
- **Paused (status ≠ 0):**
  - Buybacks and liquidity adds fail and retry each tick.
  - Fee claims and payout rounds continue.
  - Basket coins bought through Jupiter aren't affected.
- **Fee changed:** the coin's fee revenue changes from then on. Tell holders; the launch promise no longer holds for that pool.
- Neither can be reversed from our side.

**Pyth is stale or Helius is down.**
- No action needed. The affected step waits and retries every tick.
- Nothing is spent or committed on stale data.

**A round was abandoned.**
- The log says `abandoned: its seed block aged out of SlotHashes`. The keeper was down long enough that the block chosen to seed sampling left the 512-slot SlotHashes window before anyone recorded it.
- No action needed. Nothing was bought yet, the pot is untouched, and the keeper opens the next round.
- A round can't be abandoned once its seed is recorded, so a keeper can't discard a draw it dislikes.

**The keeper refuses to run with "fixed to round policy".**
- A value in `roundPolicy()` (`keeper/config.ts`) changed. Each distributor's payout rules are fixed by hash when it's created.
- Revert the change. New payout rules need a new distributor under a new keeper key, announced publicly.

**The state directory was lost.**
- Restore it from backup if at all possible.
- Otherwise the keeper finds an intent with no saved secret and abandons it:
  - immediately if the window is still open,
  - once its seed block ages out if the window closed,
  - seven days after seeding if it was seeded.
- Committed rounds the state was tracking are no longer closed automatically after expiry. `close_asset` is permissionless, so anyone can still return their leftovers to the keeper.
- Basket tokens the lost state was holding for a coin stay in the keeper wallet unattributed. They are not paid out again automatically.

**A basket coin, asset or close keeps failing.** No action needed; nothing waits on it forever.
- **Buys:** a coin that fails to buy `MAX_BUY_ATTEMPTS` times is skipped for that round, and so is anything still unbought an hour after seeding.
- **Activation:**
  - An asset that fails to activate backs off and is abandoned after `MAX_ACTIVATION_ATTEMPTS`. Its tokens return to the coin's inventory.
  - RPC errors don't count toward that limit.
- **Expired closes** back off (up to 6 hours between tries) without blocking new rounds.
- **Payouts:** RPC errors pause payouts without counting against holders.

**A window has been open for days.** The pot hasn't grown enough for a round's costs. After `MAX_ROUND_WINDOW_SECS` (7 days) the keeper abandons that window and starts a new one. Nothing was seeded or bought, so nothing is lost.
