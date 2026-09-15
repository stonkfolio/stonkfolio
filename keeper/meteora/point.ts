import BN from "bn.js";
import { Connection } from "@solana/web3.js";

const ACTIVATION_TYPE_SLOT = 0;

/**
 * The "current point" Meteora quotes need: a slot, or a unix time. The SDK's
 * own helper reads the newest slot's block time, which is often still null
 * (or the slot was skipped), so this steps back a few slots until one has a
 * time, falling back to the local clock.
 */
export async function currentPoint(connection: Connection, activationType: number): Promise<BN> {
  const slot = await connection.getSlot("confirmed");
  if (activationType === ACTIVATION_TYPE_SLOT) return new BN(slot);
  for (let back = 0; back < 10; back++) {
    const time = await connection.getBlockTime(slot - back).catch(() => null);
    if (time !== null) return new BN(time);
  }
  return new BN(Math.floor(Date.now() / 1000));
}
