#!/usr/bin/env node
// sapling-params-server.mjs — loopback-only static server for the baked Sapling
// proving parameters.
//
// WHY THIS EXISTS (verified against the real SDK + a live Node 22 repro, NOT assumed):
//   shield-bridge-sdk loads the proving parameters with the GLOBAL fetch():
//     node_modules/shield-bridge-sdk/dist/saplingCore.js
//       fetchParams(url) { const response = await fetch(url); ... }   // no fs fallback
//   Node 22.21 / undici fetch() does NOT implement the `file:` scheme:
//     fetch('file:///opt/sapling-params/sapling-spend.params')
//       -> TypeError: fetch failed   (cause: "not implemented... yet...")
//   (reproduced in-repo on node v22.21.0). So a base of
//   SAPLING_PARAMS_URL=file:///opt/sapling-params/ FAILS at first proof generation
//   — NOT at boot — which is the worst possible time to discover it.
//
//   We therefore re-serve the already-on-disk, already-checksum-verified params
//   over loopback HTTP (which fetch() DOES support) and point the relay at
//   SAPLING_PARAMS_URL=http://127.0.0.1:8091/ . The SDK's setSaplingParamsUrl
//   normalizes the base to a trailing slash and concatenates the two filenames,
//   so the two requested URLs become exactly:
//     http://127.0.0.1:8091/sapling-spend.params
//     http://127.0.0.1:8091/sapling-output.params
//
// SECURITY: binds 127.0.0.1 ONLY (never the network), serves exactly two fixed
// basenames from a whitelist, and supports nothing else — zero path-traversal
// surface. The bytes are public MPC params, not secrets.
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { join } from 'node:path';

const DIR = process.env.SAPLING_PARAMS_DIR || '/opt/sapling-params';
const HOST = '127.0.0.1';
const PORT = Number(process.env.SAPLING_PARAMS_PORT || 8091);

// Whitelist: only these two exact basenames are ever served.
const FILES = new Map([
  ['/sapling-spend.params', join(DIR, 'sapling-spend.params')],
  ['/sapling-output.params', join(DIR, 'sapling-output.params')],
]);

// Fail fast at startup if a baked file is missing (build/bake regression guard).
for (const p of FILES.values()) statSync(p);

const server = createServer((req, res) => {
  const file =
    req.method === 'GET' || req.method === 'HEAD' ? FILES.get(req.url ?? '') : undefined;
  if (!file) {
    res.writeHead(404).end();
    return;
  }
  const size = statSync(file).size;
  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-length': String(size),
    'cache-control': 'public, max-age=31536000, immutable',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(file).pipe(res);
});

server.listen(PORT, HOST, () => {
  console.log(`[sapling-params] serving ${DIR} on http://${HOST}:${PORT}/`);
});

// Exit cleanly on signals so the entrypoint can manage lifecycle/ordering.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
