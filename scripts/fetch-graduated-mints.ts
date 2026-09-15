/**
 * Prints the mint addresses of the current top-N real StonkFun-graduated
 * tokens, one per line. Standalone (not part of the keeper bot itself)
 * because mainnet-fork-validator.sh needs these addresses BEFORE the
 * validator boots — solana-test-validator only clones accounts at startup,
 * so "ask StonkFun what's graduated right now" has to happen as a separate
 * step first, not something the validator or the bot does itself here.
 *
 * Usage: npx ts-node scripts/fetch-graduated-mints.ts [limit]
 * (or, compiled: node dist/scripts/fetch-graduated-mints.js [limit])
 */
import { getTopGraduatedTokens } from "../keeper/stonkfun";

const limit = Number(process.argv[2] ?? 15);

getTopGraduatedTokens(limit)
  .then((tokens) => {
    if (tokens.length === 0) {
      console.error("StonkFun returned zero graduated tokens — nothing to clone");
      process.exit(1);
    }
    for (const t of tokens) console.log(t.mint);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
