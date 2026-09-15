# What you still have to trust

**As of commit 45b3a30, 14 Sep 2026.**

Stonkfolio runs with no admin key, no pause switch, and no human approving payouts. That is not the same as trusting no one. A Solana program can't list a token's holders, read StonkFun's rankings, or price a memecoin, so an automated keeper does those jobs. This page sorts every part of the system by what actually guarantees it.

| Tier | Guaranteed by |
|---|---|
| 1. Enforced on-chain | The distributor program. It rejects everything else. |
| 2. Checkable by anyone | Off-chain work that anyone can recompute to catch a lie. |
| 3. Trusted to the keeper | Can't be proven. Bounded where possible, disclosed where not. |
| 4. Outside our control | Third parties the launch depends on. |

## 1. Enforced on-chain

> **Condition:** everything in this tier holds only after the distributor's upgrade authority is revoked (`solana program set-upgrade-authority --final`). Until then, the deployer key can replace the program. The team keeps that key for 7 days after launch, so it can fix a problem found in live use, then revokes it and publishes the transaction.

**Payouts reach only committed holders.** Each round commits a Merkle root of every payout.
- A push lands only in the recipient's own associated token account, and only while they still own it.
- A self-claim needs the recipient's signature.
- Each payout pays once.
- Total payouts can never exceed the committed allocation.

**Every round stays claimable.** A round can't expire before the minimum set when its distributor was created. Unclaimed tokens leave only after expiry, and only back to the keeper for later rounds.

**The draw can't be rigged afterwards.**
- Before a window opens, the keeper commits to a secret on-chain.
- At close, the program records the snapshot list (as a hash chain), the snapshot count, and SOL/USD read from Pyth under age and confidence limits. The price must come from Pyth's own continuously updated SOL/USD account, and can be neither stale nor dated in the future.
- The seed is the hash of a block after the window: at least 32 slots later under the published policy (the program itself allows as few as 1). The program picks it, and anyone can record it.
- A seeded round can't be redrawn. The only exception: it can be abandoned 7 days later if the keeper lost its secret.
- If nobody records the seed within about 3.5 minutes, its block ages out and the round can only be abandoned a day after its window closed. The seed hash is public before it's recorded, so this is how a keeper could skip a draw it dislikes: each skip costs a day of rounds and is counted on the distributor (`expired_seed_abandons`) for anyone to see.

**Payout rules are fixed per coin.** The distributor stores a hash of the round policy: threshold, sampling, window, exclusions, price limits, and the 3× rent rule.

**Unsafe basket coins are refused.** The program won't hold a mint with any of these:
- a transfer hook, or an authority that could add one
- a close authority
- a transfer fee above 3%, current or already scheduled
- a permanent delegate
- non-transferable tokens
- default-frozen accounts
- a freeze authority, unless that round explicitly allows one for that coin
- an unrecognised extension

**Transfer-fee coins are accepted, within limits.** Most of StonkFun's top coins charge a 1–3% transfer fee, and many keep a fee authority that can still change it. The program accepts both, as long as the current fee and any fee already scheduled are at most 3%. A fee authority can still schedule a higher fee later. Token-2022 applies it two epochs (about 4 days) after it is set, and pushed payouts land within minutes of a round activating. So a later increase can only affect payouts left for self-claim and expiry leftovers. Every basket transfer (into the vault, and out to holders) pays the coin's fee to that coin's fee wallet, so holders receive the basket less those fees.

**Only the keeper has power.** There is no admin, pause, cancel, or multisig. The keeper can hand its role to a new key, which must accept it.

## 2. Checkable by anyone

`npm run verify-round -- <bundle> --rpc <url>` redoes all of the following against the chain:

- **Every payout and Merkle root.** Time-weighted balances, the $50 cut, exclusions, the pro-rata split, and the minimum payout, all byte-exact against the committed root and artifact hash.
- **Inputs match the chain.** The policy hash and price feed, window slots, snapshot list and count, Pyth price, seed block, and committed header.
- **Sample selection.** It follows from the program-chosen seed and the secret revealed at commit.
- **Basket cost.** Each purchase's transaction was signed by its throwaway wallet, received exactly the claimed tokens, and spent at least the claimed SOL.
- **Visible on any explorer.** Buyback burns, permanently locked liquidity, and platform revenue transfers.

> **Condition:** round bundles must be published. The public artifacts repository hasn't been chosen yet.

## 3. Trusted to the keeper

| What | What could go wrong | Limited by | How to check |
|---|---|---|---|
| Holder balances in snapshots | Accounts omitted or padded | Snapshot list sealed on-chain before the seed exists; each snapshot names its slot | Archive-RPC balances at each slot |
| Pool price in snapshots | Moves who clears $50 | Lower median across samples; keeper buybacks run after snapshots | Archive-RPC pool price at each slot |
| Basket choice and amounts | StonkFun API ranking (not the front page); carried inventory could be under-reported | Purchases are provable; carried leftovers aren't | Compare purchases and vault funding with the keeper wallet's token history |
| Snapshot timing | The keeper operator knows its own jittered snapshot times | Keeper wallet excluded; operator's other wallets aren't | After the secret is revealed, look for balances spiking at snapshot slots |
| Custody between claim and spend | Fees, cost reserves, and carried tokens sit in the hot wallet | Fees spent in the same tick; buys run from single-use wallets; journaled ledger | Wallet SOL ≥ sum of ledger buckets |
| Liveness | No claims, buys, or new rounds while the keeper is down | Committed rounds stay self-claimable until expiry; fees keep accruing, claimable only by the fee claimer | Watch the keeper address and round count |
| Pushing payouts | Could skip pushes | Can't redirect a payout; small first-time payouts deliberately left to self-claim | On-chain bitmap and `payout-failures.json` |
| Publishing bundles | Unpublished rounds can't be checked | Bundle hash committed on-chain before payouts | Every committed round has a matching bundle |

### If the keeper key is stolen

| Could | Couldn't |
|---|---|
| Take ledger SOL and carried basket tokens | Touch committed round vaults before expiry |
| Claim all future pool fees (DBC's fee claimer can't be changed) | Withdraw liquidity (permanently locked) |
| Receive leftovers from rounds as they expire | Change a coin's payout rules or price feed |
| Commit future rounds with fabricated snapshots | Redraw a seeded round or reuse a round number |
| Stop pushing payouts | Upgrade the program, once its authority is revoked |

Distributor authority can move to a new key with `propose_root_authority` then `accept_root_authority`. Fee-claim rights can't.

## 4. Outside our control

**Meteora.**
- DBC and DAMM v2 are upgradeable by `JADaUV8kvDpDbJr55wxXJHVaBS3VCj8thZZHjfeuCVLd`.
- Operators can change a graduated pool's fee or pause swaps without an upgrade.
- Migration depends on Meteora-funded rent accounts.
- The keeper checks deploy slots, upgrade authority, and the migration config against a pin every hour. It records each pool's fee and status every tick and alerts on any change. Alerting is all it can do.

**Pyth.** The program only reads Pyth's own SOL/USD account and rejects prices older than 5 minutes, dated in the future, or with confidence wider than 2%. Anyone can push a fresher verified update into that account, but never an older one, so the keeper can't pick a favourable price from the last few minutes. A stale feed delays rounds; it can't slip in a bad price.

**Jupiter and StonkFun APIs.**
- Every quote is checked to match the requested swap, with at most 1% slippage and a 1.5% impact cap.
- Each buy runs from its own throwaway wallet, so a bad route can cost only that buy.

**Helius.** Mainnet holder lists come from Helius. A wrong or stale list feeds straight into the tier 3 snapshot trust.

**Solana.** Congestion delays rounds and a halt stops everything. Neither moves funds.

## Rules this rests on (mainnet policy defaults)

| Setting | Value |
|---|---|
| Minimum holding | $50 TWAB |
| Samples per round | 24 |
| Minimum window | 6 h |
| Seed delay | ≥ 32 slots |
| Round expiry | 90 days |
| Minimum expiry | 30 days |
| Pyth max age | 300 s |
| Pyth max confidence | 200 bps |
| Auto-push floor | 3× account rent |
| Basket size | up to 30 coins |
| Swap slippage | 100 bps |
| Max price impact | 150 bps, measured against a quote 1/100th the size so a coin's transfer fee isn't counted |
| Max basket transfer fee | 300 bps, current or scheduled (enforced on-chain) |

## What shrinks the trust before mainnet

**Done**
- [x] Sampling, seed, and price moved on-chain
- [x] Basket buys isolated in throwaway wallets; quotes validated; ledger journaled
- [x] Meteora programs, authority, and migration config pinned and monitored
- [x] Unattended devnet rehearsal, every round verified on-chain

**Still to do**
- [x] External audit of the distributor, and review of its fixes
- [x] Artifacts repository chosen: github.com/stonkfolio/stonkfolio-artifacts
- [x] Review of the StonkFun fee-coin change
- [ ] Revoke the distributor's upgrade authority and publish the transaction (7 days after launch)
- [ ] Publish the keeper address, program id, distributor addresses, and Meteora pin (at launch)
- [ ] Independent archive-RPC snapshot checks (open to anyone)
