import type { Worker } from '../sapling/pool.js';

export interface RefillResult {
  refilled: boolean;
  reason?: string;
  /** XTZ unshielded back to the worker's tz1, when refilled. */
  amountXtz?: number;
  /** tz1 balance (XTZ) observed before the refill decision. */
  balanceXtz: number;
}

/**
 * Self-funding loop: when a worker's tz1 gas balance falls below the threshold,
 * unshield its accumulated Sapling fee balance back to its own tz1. The 1-XTZ
 * fees land in the worker's sapling balance, so this recycles earnings into gas.
 *
 * MUST be run through the WorkerQueue on this worker's pool index — it spends the
 * worker's sapling notes and uses its tz1 counter, so it cannot overlap a job.
 */
export async function refillWorkerGas(worker: Worker, thresholdXtz: number): Promise<RefillResult> {
  const balanceMutez = await worker.client.tz.getBalance(worker.tezosAddress);
  const balanceXtz = balanceMutez.toNumber() / 1_000_000;

  if (balanceXtz >= thresholdXtz) {
    return { refilled: false, reason: 'above threshold', balanceXtz };
  }

  const saplingXtz = await worker.sdk.getShieldedBalance({});
  if (saplingXtz <= 0) {
    return {
      refilled: false,
      reason: 'no sapling balance to unshield — fund this tz1 manually',
      balanceXtz,
    };
  }

  // Unshield the ENTIRE accumulated sapling balance back to the worker's tz1.
  const unshieldParams = await worker.sdk.constructUnshieldTokenParams({
    amount: saplingXtz,
    unshieldedAddress: worker.tezosAddress,
  });
  await worker.sdk.submitSaplingUnshieldTransaction([unshieldParams]);

  return { refilled: true, amountXtz: saplingXtz, balanceXtz };
}
