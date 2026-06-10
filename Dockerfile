# syntax=docker/dockerfile:1.7
# =============================================================================
# shield-relay — multi-arch (linux/amd64 + linux/arm64) production image
# =============================================================================
# Strategy
#   * Base: debian bookworm slim (glibc). better-sqlite3 11.10.0 ships GLIBC
#     prebuilt addons for node-v127 (Node 22 ABI) on BOTH linux-x64 and
#     linux-arm64, so no source compile is needed on either arch. Musl/alpine
#     would force a from-source build of better-sqlite3 (musl prebuilds exist
#     but are less battle-tested for this workload) — we choose glibc for
#     reliability + portability per the brief.
#   * The Sapling proving core is @airgap/sapling-wasm (WebAssembly, JS-embedded)
#     — architecture-INDEPENDENT. The ONLY native addon in the tree is
#     better-sqlite3. So a native cross-compile is NOT on the critical path:
#     under `buildx --platform linux/amd64,linux/arm64`, each arch's `npm ci`
#     pulls that arch's prebuilt better-sqlite3 binary. QEMU only has to run
#     `npm`/`tsc` (pure JS) and the prebuild-install download — never gcc.
#   * Multi-stage: (1) builder = full toolchain + dev deps + tsc; (2) prod-deps =
#     `npm ci --omit=dev` keeping the arch-correct compiled better-sqlite3 addon;
#     (3) params = relocate the SDK-bundled Sapling params + checksum-gate them;
#     (4) runtime = slim, non-root, tini PID-1.
#   * Layer-cache ordering: package*.json copied BEFORE src so a code-only edit
#     does not bust the dependency layer.
#
# SAPLING PARAMS — THE CRUX (verified against the real SDK + a live Node 22 repro):
#   The SDK loads params with the GLOBAL fetch() (saplingCore.js fetchParams), and
#   Node 22 fetch() does NOT implement the file: scheme — fetch('file://…') throws
#   "not implemented... yet...". So baking at file:///opt/sapling-params/ would FAIL
#   at first proof generation. We instead bake the params AND serve them over a
#   loopback-only HTTP server (docker/sapling-params-server.mjs), starting it via
#   docker/entrypoint.sh BEFORE `relay start`, with
#       SAPLING_PARAMS_URL=http://127.0.0.1:8091/   (trailing slash MANDATORY —
#   the SDK concatenates `${base}sapling-spend.params`). No relay source change.
#
# Pinned via build args (override at build time, not baked assumptions):
ARG NODE_VERSION=22.21.0
ARG DEBIAN_VARIANT=bookworm-slim

# -----------------------------------------------------------------------------
# Stage 1 — builder: install ALL deps (incl dev) and compile TS -> dist/
# -----------------------------------------------------------------------------
FROM node:${NODE_VERSION}-${DEBIAN_VARIANT} AS builder
WORKDIR /app

# Build deps for the fallback path ONLY. With glibc prebuilds present these are
# never exercised on amd64/arm64, but they make the build self-healing if a
# prebuild is ever missing (and keep `npm ci` from hard-failing under QEMU).
# python3 + build-essential are needed for any node-gyp fallback compile.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
      python3 build-essential ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Dependency layer first — cached across source-only changes.
# package-lock.json is the integrity anchor; `npm ci` is fully reproducible.
COPY package.json package-lock.json ./
# Keep node-gyp able to compile if a prebuild is unexpectedly absent; otherwise
# prebuild-install fetches the arch-correct better_sqlite3.node.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --include=dev

# Now the source. tsconfig drives tsc -> dist/.
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && test -f dist/cli/index.js

# -----------------------------------------------------------------------------
# Stage 2 — production deps: prune to runtime deps, KEEP compiled better-sqlite3
# -----------------------------------------------------------------------------
# A clean `npm ci --omit=dev` in its own stage. better-sqlite3 is a runtime
# dependency, so `npm ci` re-resolves its prebuilt (or compiled) addon for the
# CURRENT build platform — i.e. the TARGET arch under buildx. No manual copy of
# the .node is needed; npm owns it. The `test -f …better_sqlite3.node` line fails
# the build LOUDLY if a prebuild silently went missing on either arch.
FROM node:${NODE_VERSION}-${DEBIAN_VARIANT} AS prod-deps
WORKDIR /app
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
      python3 build-essential ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev \
 && test -f node_modules/better-sqlite3/build/Release/better_sqlite3.node \
 && test -f node_modules/comlink/dist/umd/node-adapter.js \
 && npm cache clean --force

# -----------------------------------------------------------------------------
# Stage 3 — params: relocate the Sapling MPC params + checksum-verify them
# -----------------------------------------------------------------------------
# ~49 MB total, architecture-independent (consumed by @airgap/sapling-wasm). The
# params already arrive via `npm ci` — shield-bridge-sdk bundles them in its dist/
# and they are BYTE-IDENTICAL to the canonical z.cash MPC params. So instead of a
# build-time download of download.z.cash (a network dependency that breaks
# air-gapped CI), we relocate the bundled copies into a stable dedicated dir and
# GATE on the pinned z.cash sha256. That gate doubles as a supply-chain check on
# the npm package: a tampered param file aborts the build. No network, no curl.
FROM debian:${DEBIAN_VARIANT} AS params
WORKDIR /opt/sapling-params
COPY --from=prod-deps /app/node_modules/shield-bridge-sdk/dist/sapling-spend.params  ./sapling-spend.params
COPY --from=prod-deps /app/node_modules/shield-bridge-sdk/dist/sapling-output.params ./sapling-output.params
# Pinned canonical z.cash checksums (zcash fetch-params). Mismatch => build fails.
RUN set -eu; \
    echo "8e48ffd23abb3a5fd9c5589204f32d9c31285a04b78096ba40a79b75677efc13  sapling-spend.params"  | sha256sum -c -; \
    echo "2f0ebbcbb9bb0bcffe95a397e7eba89c29eb4dde6191c339db88570e3f3fb0e4  sapling-output.params" | sha256sum -c -; \
    chmod 0444 sapling-spend.params sapling-output.params

# -----------------------------------------------------------------------------
# Stage 4 — runtime: slim, non-root, tini PID-1, no toolchain
# -----------------------------------------------------------------------------
FROM node:${NODE_VERSION}-${DEBIAN_VARIANT} AS runtime

# tini = correct PID-1 signal forwarding so the SIGTERM/SIGINT drain in start.ts
# actually fires (stop intake -> finish in-flight -> release instance lock).
# curl = a tiny http client for container/compose healthchecks (node:slim ships
# NEITHER wget NOR curl by default). ca-certificates = HTTPS RPC trust.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
      tini ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# SAPLING_PARAMS_URL: http loopback (NOT file://). The SDK fetches params over the
#   network via global fetch(), which can't read file: URLs on Node 22; the
#   entrypoint serves the baked params on 127.0.0.1:8091 and the SDK appends
#   'sapling-spend.params'/'sapling-output.params' to this base (trailing slash
#   MANDATORY). SAPLING_PARAMS_DIR/PORT are read by the params server + entrypoint.
# DATA_DIR: local-FS data dir — MUST be a LOCAL volume at runtime (SQLite WAL +
#   instance_lock corrupt on networked FS; the relay refuses unless ALLOW_NETWORK_FS).
# NODE_OPTIONS --import: the SDK loads worker_threads + comlink via eval('require')
#   in BOTH the main thread AND the spawned Sapling worker. The relay is pure ESM
#   (no require), so without this the worker dies with "require is not defined" the
#   moment the pool builds. A --import preload installs a global require into EVERY
#   isolate (workers inherit NODE_OPTIONS), which a static import cannot do. See
#   src/runtime/saplingRequireShim.ts. THIS LINE IS LOAD-BEARING — do not remove.
ENV NODE_ENV=production \
    NODE_OPTIONS=--import=file:///app/dist/runtime/saplingRequireShim.js \
    SAPLING_PARAMS_URL=http://127.0.0.1:8091/ \
    SAPLING_PARAMS_DIR=/opt/sapling-params \
    SAPLING_PARAMS_PORT=8091 \
    DATA_DIR=/data \
    PORT=8080

WORKDIR /app

# Runtime artifacts only — no source, no dev deps, no build tools.
# Ownership set to the unprivileged `node` user (uid/gid 1000, ships in the image).
COPY --chown=node:node --from=prod-deps /app/node_modules ./node_modules
COPY --chown=node:node --from=builder   /app/dist ./dist
COPY --chown=node:node package.json ./

# Sapling params, baked read-only (NOT a secret; public MPC params), plus the
# loopback server + entrypoint that serve them to the SDK's fetch().
COPY --from=params /opt/sapling-params /opt/sapling-params
COPY docker/sapling-params-server.mjs /opt/sapling-params-server.mjs
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh /opt/sapling-params-server.mjs

# Data dir owned by the runtime user so the volume mount is writable as non-root.
RUN install -d -o node -g node -m 0700 /data

# Drop privileges. NEVER run the relay as root; it only needs to bind PORT
# (>1024), the loopback params port, and write /data + the WASM/proof temp.
USER node

EXPOSE 8080

# Liveness probe hits the always-on /healthz (200 whenever the process is up).
# Uses node's built-in fetch so NO external binary is required. Readiness
# (/readyz -> 503 while the pool builds OR during drain) is for a load balancer,
# NOT Docker's restart loop — do not point a restart-on-unhealthy watchdog at it.
# start-period covers loading ~50 MB params + deriving each worker's address.
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Make the stop signal explicit; the relay's drain handler listens for SIGTERM.
STOPSIGNAL SIGTERM

# tini as PID-1 (forwards signals + reaps zombies from sapling worker_threads) ->
# entrypoint.sh (starts the loopback params server for `start`, then exec's the
# relay so it inherits tini's forwarded signals for a graceful drain).
# -g signals the whole PROCESS GROUP, so SIGTERM reaches BOTH the exec'd relay AND
# the backgrounded params server (after exec the shell trap is gone — see entrypoint).
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/usr/local/bin/entrypoint.sh"]
# Default to the server. Override (e.g. `init`, `doctor`, `jobs`) at `docker run`.
CMD ["start"]
