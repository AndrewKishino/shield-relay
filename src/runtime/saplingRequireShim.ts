import { createRequire } from 'node:module';

/**
 * ESM ⇄ CJS shim for shield-bridge-sdk's Node worker-spawn path.
 *
 * The SDK's createWorker() — the `parallelThreads: true` path the relay DEPENDS on
 * for per-worker Sapling proving isolation (DESIGN.md §1) — loads worker_threads +
 * comlink via `eval('require')`, a CommonJS assumption. The relay is pure ESM
 * (`type: module`), where `require` is undefined even via eval, so that call throws
 * "require is not defined" and the entire pool build fails at boot. (The original
 * AWS backend sidestepped this with parallelThreads:false — the direct-import path
 * that never spawns a worker — but that mode aliases every worker to one global
 * Sapling core and corrupts spending keys, which is exactly why we can't use it.)
 *
 * Exposing `require` on globalThis lets the SDK's `eval('require')` resolve through
 * the global object. Imported for side effect at the very top of the CLI entrypoint
 * (and `relay dev`), before any SDK is constructed. Idempotent.
 */
const g = globalThis as typeof globalThis & { require?: NodeJS.Require };
if (typeof g.require === 'undefined') {
  g.require = createRequire(import.meta.url);
}
