#!/usr/bin/env node
import { Command } from 'commander';
import { start } from './start.js';
import { init } from './init.js';
import { doctor } from './doctor.js';

const program = new Command();
program
  .name('relay')
  .description('Shield Bridge privacy relay — broadcast Sapling transactions for a fee, anonymously.')
  .version('0.0.0');

program
  .command('start')
  .description('Run the relay server')
  .action(async () => {
    try {
      await start();
    } catch (e) {
      console.error('Failed to start:', e instanceof Error ? e.message : e);
      process.exit(1);
    }
  });

program
  .command('init')
  .description('Mint a fresh worker pool and print the tz1 addresses to fund')
  .requiredOption('-w, --workers <n>', 'number of workers to mint', (v) => parseInt(v, 10))
  .option('-o, --out <path>', 'pool secret output path', './secrets/pool.json')
  .option('-f, --force', 'overwrite an existing pool secret (DANGER)', false)
  .action(async (opts: { workers: number; out: string; force: boolean }) => {
    try {
      await init({ workers: opts.workers, out: opts.out, force: opts.force });
    } catch (e) {
      console.error('init failed:', e instanceof Error ? e.message : e);
      process.exit(1);
    }
  });

program
  .command('doctor')
  .description('Preflight checks (RPC, contract, worker balances, RAM, DB, port)')
  .action(async () => {
    try {
      await doctor();
    } catch (e) {
      console.error('doctor failed:', e instanceof Error ? e.message : e);
      process.exit(1);
    }
  });

await program.parseAsync(process.argv);
