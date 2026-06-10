import type { TezosToolkit } from '@tezos-x/octez.js';

/**
 * V2 Factory storage shape (the bits we read). The Factory maps each asset to
 * the Sapling "Set" contract that holds its shielded state.
 */
interface FactoryStorage {
  tez: string;
  token_fa_1_2: { get(contract: string): Promise<string | undefined> };
  token_fa_2: { get(key: { contract: string; token_id: number }): Promise<string | undefined> };
}

/**
 * Module-level cache: Set addresses never change once the Factory creates them,
 * and they are global (not per-worker), so any worker's client may resolve them.
 */
const setAddressCache = new Map<string, string>();

function cacheKey(contract?: string, tokenId?: number): string {
  if (!contract) return 'tez';
  return tokenId !== undefined ? `${contract}:${tokenId}` : contract;
}

/**
 * Resolve the Sapling Set contract address for an asset by reading Factory
 * storage. `contract` undefined → native XTZ; with `tokenId` → FA2; without → FA1.2.
 */
export async function resolveSetAddress(
  client: TezosToolkit,
  factoryAddress: string,
  contract?: string,
  tokenId?: number,
): Promise<string> {
  const key = cacheKey(contract, tokenId);
  const hit = setAddressCache.get(key);
  if (hit) return hit;

  const factory = await client.contract.at(factoryAddress);
  const storage = await factory.storage<FactoryStorage>();

  let setAddress: string | undefined;
  if (contract) {
    setAddress =
      tokenId !== undefined
        ? await storage.token_fa_2.get({ contract, token_id: tokenId })
        : await storage.token_fa_1_2.get(contract);
  } else {
    setAddress = storage.tez || undefined;
  }

  if (!setAddress) {
    throw new Error(`Sapling Set not found for ${key}. Has it been created in the Factory?`);
  }
  setAddressCache.set(key, setAddress);
  return setAddress;
}
