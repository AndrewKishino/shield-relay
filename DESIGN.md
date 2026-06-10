# shield-relay — Architecture & Build Plan

> Build-ready blueprint for a standalone, containerized, multi-host Shield Bridge privacy relay. Synthesized from the Shield Bridge `docs/RELAY_NETWORK_DESIGN.md` (§6 packaging) + a multi-agent design pass (repo/DX, security/keys, SRE/durability lenses landed; runtime-resilience + portability + final synthesis to be completed — workflow `wf_accc4921-0a0`, resumable).

## Goal

Re-implement the **already-frozen, production-live** wire protocol (`shield-relay/1`) as **one Node process / one Docker image** — reliable and resilient enough that Shield Bridge would migrate its own production relay onto it, and easy enough that a homelabber runs one in <30 min. **No changes to the existing AWS backend**; this is a clean parallel implementation that reuses `shield-bridge-sdk` for all Sapling/Tezos logic.

## Tech stack (decided)

| Concern | Choice | Why |
|---|---|---|
| Runtime | Node 22 + TypeScript, ESM | reuse `shield-bridge-sdk` + `@tezos-x/octez.js` verbatim |
| HTTP+WS server | Fastify + `ws` | light, fast, first-class WebSocket; no cloud transport dep |
| State store | SQLite (`better-sqlite3`) default, Postgres via `DATABASE_URL` | zero-ops for homelab; HA path later. One `Store` interface |
| Queue | in-process **per-worker promise-chain mutex** (no SQS) | a single process owning all workers is a *stronger* sequential-per-worker guarantee than SQS FIFO, and deletes the AddressPool lease machinery |
| Config | single `zod` schema, fail-fast at boot | kills the config drift seen in the Lambda `shared/constants` |
| Logging | `pino` JSON + redaction allowlist | systemic guard against secret/hash leaks |
| Metrics | `prom-client` → `/metrics` | operator answers: stalled worker? earning? slow proofs? |
| CLI | `commander` — `relay init|start|doctor|keys` | replaces `setup-secrets.sh` + `InitializePool`; `doctor` is the <30-min DX guarantee |
| Container | single multi-arch (amd64+arm64) image, **Sapling params baked in** | offline/firewalled friendly (Akash, air-gapped homelab); no 52 MB cold fetch |

## Repo file tree

```
shield-relay/
├── src/
│   ├── cli/            # commander entry: init / start / doctor / keys
│   ├── config/         # schema.ts (zod, single source of truth) + load()
│   ├── core/           # PURE domain — no I/O framework
│   │   ├── worker-queue.ts   # per-worker single-concurrency mutex (THE invariant)
│   │   ├── jobs.ts           # job lifecycle state machine
│   │   ├── payment.ts        # Phase-1 verify-memo (re-impl of verifyPaymentMemo)
│   │   ├── inject.ts         # Phase-2 broadcast (re-impl of injectUserTransaction)
│   │   ├── set-address.ts    # resolveSetAddress from Factory storage
│   │   └── gas-refill.ts     # unshield worker sapling balance → tz1 (through the queue)
│   ├── sapling/        # ShieldBridgeSDK + TezosToolkit/InMemorySigner wiring, pool loading
│   ├── store/          # Store interface + sqlite.ts + postgres.ts
│   ├── server/         # fastify routes (/get-worker-info, /submit-payment,
│   │                   #   /submit-user-transaction) + ws-hub.ts (Map<jobId,Set<ws>>)
│   ├── observability/  # logger.ts (pino+redaction), metrics.ts, health.ts
│   └── index.ts
├── test/               # unit + the sequential-per-worker invariant test + shadownet integration
├── docker/             # Dockerfile (multi-stage, params baked), entrypoint
├── deploy/             # compose.yml (+ Caddy TLS), fly.toml, railway.json, render.yaml, k8s/, akash/
├── docs/               # operator runbook, SHIELD_RELAY_PROTOCOL.md (the frozen spec)
├── .github/workflows/  # ci.yml (typecheck/lint/test/build) + release.yml (multi-arch → GHCR)
├── DESIGN.md  README.md  LICENSE  package.json  tsconfig.json  .gitignore  .dockerignore
```

## The resilience core (most important)

**Sequential-per-worker invariant.** `core/worker-queue.ts` keeps `Map<workerIndex, Promise>`; `enqueue(workerIndex, task)` chains `task` onto that worker's promise. **Everything that touches a worker's tz1 counter or sapling notes** routes through it: Phase-1 payment injection (payment worker), Phase-2 broadcast (broadcast worker), and **gas-refill** (it spends that worker's notes — must hold the same lock). One process = a strictly stronger guarantee than SQS FIFO.

**Crash-safety (the new failure class vs Lambda+SQS).** A durable `work_queue` table in SQLite is the source of truth, not the in-memory chain:
1. `submit-payment` / `submit-user-transaction` → **durably write** the job + a `pending` work item, *then* enqueue in-memory. Return 202/200.
2. The queue task, on completion, marks the work item `done` in the **same transaction** as the status update.
3. **On boot**, re-hydrate: every `pending`/`in-flight` work item is re-enqueued to its worker. So a `kill -9` mid-Phase-1 resumes the job after restart — no stranded paid job.
4. **No-double-broadcast** under at-least-once redelivery: before broadcasting, check on-chain idempotency — Phase-1's memo via `getShieldedTransactions` (already consumed → skip), Phase-2 via the consumed-memo guard + a per-job `broadcast_op_hash` written before/after send so a replay detects "already sent." The **consumed-memo guard** is `INSERT` into `UNIQUE(memo)` that throws on duplicate (atomic; never SELECT-then-INSERT; never swept) — reproduces DynamoDB's `attribute_not_exists`.

**Graceful drain.** SIGTERM → stop accepting new jobs (`/readyz` flips), let in-flight per-worker tasks finish (bounded), flush, exit. Supervisor (`restart: always` / Fly auto-restart) + crash-loop backoff.

## Hard invariants (must always hold)

1. **Sequential-per-worker** — per-worker mutex; gas-refill routed through it; proven by a concurrency test (fire concurrent jobs at one worker → assert strictly serialized SDK calls).
2. **Payment-before-reveal** — Phase-2 work item is only created after `payment_confirmed`.
3. **Permanent atomic replay guard** — `UNIQUE(memo)` insert; never swept.
4. **Restart-safety / no-double-broadcast** — durable work queue + boot re-hydration + on-chain idempotency checks.
5. **Compat** — serves `shield-relay/1` byte-for-byte; canonical status enum only; never echo `paymentTxHash`.

## Deploy matrix (Compose first, per owner)

| Target | Needs | Notes |
|---|---|---|
| **Docker Compose (VPS/homelab)** ✅ first | `deploy/compose.yml` + Caddy/Traefik for TLS; a named volume for `DATA_DIR` | the baseline; ARM64 image for Pi-class boxes |
| Fly.io | `fly.toml` + a volume | good WS + volumes; `[mounts]` for SQLite |
| Railway / Render | `railway.json` / `render.yaml` | PaaS one-click; attach a disk |
| Kubernetes | `deploy/k8s/` (StatefulSet + PVC + Service) | StatefulSet for the SQLite volume |
| Akash | `deploy/akash/deploy.yaml` (SDL) | baked params shine here (no egress to z.cash) |

Image: multi-arch (amd64+arm64), multi-stage, ~52 MB Sapling params baked, `MAX_CONCURRENT_PROOFS` semaphore (default 1–2) to bound RAM regardless of worker count.

## Config knobs (env — single zod schema)

`TEZOS_NETWORK` · `TEZOS_RPC_URL` · `TZKT_API` · `SHIELD_BRIDGE_CONTRACT` (defaulted/network) · `PAYMENT_AMOUNT_MUTEZ=1000000` · `REQUIRE_JOB_SECRET=false` · `POOL_JSON` | `POOL_FILE` · `DATA_DIR` · `DATABASE_URL?` · `PORT` · `MAX_CONCURRENT_PROOFS=2` · `GAS_REFILL_THRESHOLD_XTZ=5` · `GAS_REFILL_INTERVAL_MS` · `RATE_LIMIT_*` · `ALERT_WEBHOOK_URL?` · `LOG_LEVEL`.

## Security / key custody

- Pool secrets via `POOL_JSON` env / mounted `POOL_FILE` (0600) / optional age-encrypted-at-rest; **never in logs or the image**. `pino` redaction allowlist blocks `saplingMnemonic`/`tezosSecretKey`/`jobSecret`/raw txn hex/`paymentTxHash`.
- Hot-wallet float capped by the gas-refill unshield.
- **Gas-burn grief** (a valid-but-non-paying Phase-1 tx burns operator gas before the memo can be verified — the "dry-run before broadcast" fix is **infeasible** because the Sapling memo/value is only decryptable from on-chain state *after* mining): accept it (symmetric + sub-cent) + per-IP rate limit + circuit breaker; price it into the fee.
- Signed + pinned container images, SBOM. Log-minimization default: the relay never needs to retain client IPs.

## Definition of done — "would we migrate prod to it?"

- [ ] Serves `shield-relay/1`; the live Shield Bridge app works against it unchanged (shadownet first).
- [ ] Sequential-per-worker invariant test green; chaos test (`kill -9` mid-Phase-1/2/gas-refill) → no double-broadcast, no stranded paid job.
- [ ] Boot re-hydration verified; state backup/restore (SQLite backup or Litestream → object storage).
- [ ] Gas auto-refill + low-balance alerting (webhook).
- [ ] `/healthz` `/readyz` `/metrics` + a Grafana dashboard + alert rules.
- [ ] Graceful drain on SIGTERM; survives `docker restart`.
- [ ] `relay doctor` catches every misconfig; <30-min homelab setup validated.

## Phased build plan

- **P1 — MVP (works against shadownet):** config + store + sapling wiring + the per-worker queue + the 3 REST routes + WS hub + the domain re-impl (payment verify / inject / set-address) + `relay init`/`start`/`doctor`. Goal: the shadownet app completes a relayed transfer through it.
- **P2 — Resilient + observable:** durable work queue + boot re-hydration + idempotency + graceful drain + pino/metrics/health + the invariant + chaos tests + gas-refill loop + alerting.
- **P3 — Multi-host:** Dockerfile (multi-arch, baked params) + Compose/Caddy + Fly/Railway/Render/k8s/Akash templates + CI publish to GHCR + the operator runbook + `SHIELD_RELAY_PROTOCOL.md`.
- **P4 — Registry-ready:** `/.well-known/shield-relay.json` (`/info`) capability endpoint; readiness for the on-chain registry + the multi-relay client (those live in the Shield Bridge app).

## Open decisions for the owner

- Reuse `shield-bridge-sdk` as a published npm dep, or vendor the minimal Sapling surface? (dep = no divergence; vendor = no external release coupling)
- Litestream-to-object-storage for SQLite PITR backups in the default image, or document it as opt-in?
- Min worker pool / RAM floor we officially "bless" for a homelab (e.g. 2 workers / 4 GB)?
- Enforce `REQUIRE_JOB_SECRET=true` by default in this server (stricter than the AWS default), since all current clients send it?
