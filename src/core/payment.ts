import type { TezosToolkit } from '@tezos-x/octez.js';
import type { ShieldBridgeSDK } from 'shield-bridge-sdk';
import type { ContractParams } from './types.js';
import { resolveSetAddress } from './setAddress.js';
import { sendSaplingOpCapped } from './broadcast.js';

/**
 * Phase 1 — broadcast the user's payment (a 1-XTZ shielded transfer to the
 * worker, in the XTZ Set contract) from the PAYMENT worker's tz1. `onBroadcast`
 * fires with the op hash *after* `.send()` resolves but *before* confirmation,
 * so the caller can durably record the broadcast intent (P2 counter-pin) before
 * awaiting confirmation. Returns the op hash.
 */
export async function broadcastPayment(
  client: TezosToolkit,
  factoryAddress: string,
  payment: ContractParams,
  confirmations: number,
  onBroadcast?: (opHash: string) => void,
): Promise<string> {
  const xtzSetAddress = await resolveSetAddress(client, factoryAddress);
  const setContract = await client.contract.at(xtzSetAddress);
  const op = await sendSaplingOpCapped(client, setContract.methodsObject.default!(payment.txns), 'payment');
  onBroadcast?.(op.hash);
  await op.confirmation(confirmations);
  return op.hash;
}

/**
 * Verify the payment memo appeared in the worker's incoming shielded XTZ
 * transactions with value >= the expected fee. Compares in INTEGER mutez
 * (receipt.value is tez) to avoid float `>=` fragility (e.g. 0.1+0.2).
 */
export async function verifyPaymentMemo(
  sdk: ShieldBridgeSDK,
  memo: string,
  expectedMutez: bigint,
): Promise<boolean> {
  const txs = await sdk.getShieldedTransactions(); // XTZ pool (no contract/tokenId)
  const receipt = txs.incoming.find((t) => t.memo === memo);
  if (!receipt) return false;
  const receivedMutez = BigInt(Math.round(receipt.value * 1_000_000));
  return receivedMutez >= expectedMutez;
}
