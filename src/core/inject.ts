import type { TezosToolkit } from '@tezos-x/octez.js';
import type { ContractParams } from './types.js';
import { resolveSetAddress } from './setAddress.js';
import { sendSaplingOpCapped } from './broadcast.js';

/**
 * Phase 2 — broadcast the user's real operation(s) from the BROADCAST worker's
 * tz1 (a distinct tz1 from Phase 1). Single op → call the Set contract directly;
 * multiple → one batched operation across Set contracts. `onBroadcast` fires with
 * the op hash post-`.send()`, pre-confirmation (for P2 durable intent). Returns
 * the op hash.
 */
export async function injectUserTransaction(
  client: TezosToolkit,
  factoryAddress: string,
  userTransaction: ContractParams | ContractParams[],
  confirmations: number,
  onBroadcast?: (opHash: string) => void,
): Promise<string> {
  const txArray = Array.isArray(userTransaction) ? userTransaction : [userTransaction];

  if (txArray.length === 1) {
    const params = txArray[0]!;
    const setAddress = await resolveSetAddress(client, factoryAddress, params.contract, params.token_id);
    const setContract = await client.contract.at(setAddress);
    const op = await sendSaplingOpCapped(client, setContract.methodsObject.default!(params.txns), 'user_tx');
    onBroadcast?.(op.hash);
    await op.confirmation(confirmations);
    return op.hash;
  }

  // Batch: multiple Set-contract calls in one operation.
  const batch = client.contract.batch();
  for (const params of txArray) {
    const setAddress = await resolveSetAddress(client, factoryAddress, params.contract, params.token_id);
    const setContract = await client.contract.at(setAddress);
    batch.withContractCall(setContract.methodsObject.default!(params.txns));
  }
  const op = await batch.send();
  onBroadcast?.(op.hash);
  await op.confirmation(confirmations);
  return op.hash;
}
