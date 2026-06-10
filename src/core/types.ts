/** The exact contract-call shape clients send and workers broadcast (one Sapling op group). */
export interface ContractParams {
  /** Hex-encoded sapling transactions. */
  txns: string[];
  /** Token contract (omitted/undefined for native XTZ). */
  contract?: string;
  /** FA2 token id (snake_case per Tezos convention). */
  token_id?: number;
}
