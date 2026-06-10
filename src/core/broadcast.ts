import type { TezosToolkit, ContractMethodObject, ContractProvider } from '@tezos-x/octez.js';

/**
 * Tezos protocol per-operation gas cap. octez.js's auto-`.send()` declares
 * gasLimit = (consumed gas + a safety buffer); for a sapling op sitting near this cap
 * the buffer pushes the DECLARED limit over it, and the node rejects with
 * `gas_limit_too_high`. So we estimate explicitly, log the real consumed gas, and
 * declare a gasLimit clamped to the protocol max.
 */
const HARD_GAS_LIMIT_PER_OP = 1_040_000;

/**
 * Send a Set-contract `default` call (a sapling op) with the gas limit capped at the
 * protocol per-operation maximum. If the op genuinely CONSUMES more than the cap (a
 * sapling tx with too many input notes), no gas setting can make it fit — we throw a
 * clear, actionable error instead of the cryptic node rejection.
 */
export async function sendSaplingOpCapped(
  client: TezosToolkit,
  method: ContractMethodObject<ContractProvider>,
  label: string,
) {
  const est = await client.estimate.contractCall(method);
  const consumedGas = Math.ceil(Number(est.consumedMilligas) / 1000);
  // Diagnostic: surfaces whether the op fits (consumed <= cap, the buffer was the
  // problem) or genuinely exceeds the per-op limit (too many input notes).
  console.log(
    `[relay-broadcast ${label}] consumed=${consumedGas} gas · octez-limit=${est.gasLimit} · storage=${est.storageLimit} · fee=${est.suggestedFeeMutez}mutez · cap=${HARD_GAS_LIMIT_PER_OP}`,
  );
  if (consumedGas > HARD_GAS_LIMIT_PER_OP) {
    throw new Error(
      `This sapling operation needs ${consumedGas} gas, over the ${HARD_GAS_LIMIT_PER_OP} per-operation cap — the transaction is too large to inject (likely too many input notes; the shielded balance may need consolidating).`,
    );
  }
  return method.send({
    gasLimit: Math.min(Number(est.gasLimit), HARD_GAS_LIMIT_PER_OP),
    storageLimit: est.storageLimit,
    fee: est.suggestedFeeMutez,
  });
}
