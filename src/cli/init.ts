import { mkdirSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { generateMnemonic } from 'bip39';
import { InMemorySigner } from '@tezos-x/octez.js-signer';
import type { WorkerSecret } from '../sapling/pool.js';

export interface InitOptions {
  workers: number;
  out: string;
  force: boolean;
}

/**
 * `relay init` — mint a fresh worker pool OFFLINE. Each worker is just an independent
 * Tezos signing key (tz1) — under the unshield-payment model a worker only broadcasts
 * ops and receives fees, so it needs no Sapling account. Writes the pool secret at 0600
 * and prints the tz1 gas-funding addresses.
 *
 * Cold-start gas is manual: each tz1 must be funded once; after that fees land directly
 * on the worker tz1 (the relay never moves funds itself).
 */
export async function init(opts: InitOptions): Promise<void> {
  if (opts.workers < 1) throw new Error('--workers must be >= 1');
  if (existsSync(opts.out) && !opts.force) {
    throw new Error(
      `${opts.out} already exists. Refusing to overwrite — use --force ONLY if you have no funds on the existing workers (overwriting loses their keys).`,
    );
  }

  const addresses: WorkerSecret[] = [];
  const funding: { index: number; tz1: string }[] = [];

  for (let i = 0; i < opts.workers; i++) {
    const tezosMnemonic = generateMnemonic(256); // 24 words
    const signer = await InMemorySigner.fromMnemonic({ mnemonic: tezosMnemonic });
    const tezosSecretKey = await signer.secretKey();
    const tz1 = await signer.publicKeyHash();
    addresses.push({ tezosSecretKey });
    funding.push({ index: i, tz1 });
  }

  mkdirSync(dirname(opts.out), { recursive: true });
  writeFileSync(opts.out, `${JSON.stringify({ addresses }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(opts.out, 0o600); // enforce even if a prior umask widened it

  console.log(`\n✓ Minted ${opts.workers} worker(s) → ${opts.out}  (chmod 0600)\n`);
  console.log('Fund EACH tz1 below with ~5–10 XTZ for gas (one-time; fees self-fund afterward):\n');
  for (const f of funding) console.log(`   worker ${f.index}:  ${f.tz1}`);
  console.log(
    '\n⚠  Back up this pool secret somewhere safe. Losing it means losing the workers’ funds.',
  );
  console.log('   It is git-ignored and never logged. Point the relay at it via POOL_FILE.\n');
}
