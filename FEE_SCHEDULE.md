# Fee Schedule — Replacing the Flat 1 XTZ Relay Fee

**Status:** relay side IMPLEMENTED (ships dark — `src/core/feeSchedule.ts`, the quote
at `get-worker-info`, Phase-1 verify against the stored quote, Phase-2 `txCount`
enforcement). The empirical sweep is DONE (§6.1) and the recommended values are sized for a
**≥20% profit floor on the worst-observed (all-max-fragmentation) batch**: `baseMutez=300k`,
`perTxMutez=270k`, `quantumMutez=250k`, `LEGACY_FLAT_MAX_TXS=5`. The shield-bridge V3 client
already honors the quoted `paymentAmount` + sends `txCount`, so the schedule is READY to enable:
an operator opts in by setting those `FEE_*` env values (defaults still reproduce the flat fee).
Companion to `DESIGN.md` (`shield-relay/1`).

> **⚠ Payment mechanics changed (2026-06) — option B.** The fee is no longer a *shielded*
> transfer redeemed later by `refillWorkerGas`. It is now a **public unshield of the fee
> straight to the worker's tz1**, verified BEFORE broadcast. So: the worker is paid in
> spendable tz1 XTZ on the spot (no shielded balance accrues, no redemption leg), and
> **`refillWorkerGas`/gas-refill is gone** — workers self-fund because each fee already
> lands on tz1. The §ROI/redemption discussion below that assumes a shielded fee +
> unshield-to-realize is superseded; the quote *amounts* (base/per-tx/quantum) are
> unchanged. The fee collection is now PUBLIC (worker tz1 receipts are observable; the
> sapling spender stays private). The code is the source of truth.
**Source data:** mainnet operation [`ooRSpM5TDKpr1SEchYaxhJgFQQrzGB1sTZWLZXauMV49kr5AhkZ`](https://tzkt.io/ooRSpM5TDKpr1SEchYaxhJgFQQrzGB1sTZWLZXauMV49kr5AhkZ) — a real 10-asset relay batch (20 contents) that collected the flat 1 XTZ fee.

---

## 1. The problem: the flat fee is underwater at the batch cap

The relay charges a flat fee (`PAYMENT_AMOUNT_MUTEZ`, default 1 XTZ —
`src/config/schema.ts`) regardless of how many sapling transactions the job
injects. Measured against the real batch above:

| Component | Cost (XTZ) |
| --- | --- |
| Baker fee (gas + op bytes) | 0.0548 |
| **Storage burn** (contract storage growth) | **0.8455** |
| **Total cost** | **0.900** |
| Revenue (flat fee) | 1.000 |

Storage burn is **94% of real cost** and was the term the original "margin is
90–99%" estimate missed. Every sapling `default` call appends nullifiers,
commitments, and ciphertexts to contract storage. The §6.1 mainnet sweep (50 ops)
measured **307–838 bytes per sapling tx**, i.e. **0.077–0.21 XTZ per tx** at the
protocol's 250 µꜩ/byte — bimodal: a ~0.085 XTZ single-input p50 and a heavy tail
(~0.16–0.21 XTZ) for multi-input / 2-output ops. Gas adds only ~0.005 XTZ per tx
(~31k gas per sapling tx; ~82k for the XTZ set).

Per-job economics at the flat 1 XTZ fee:

| Job shape | Approx. cost (XTZ) | Margin |
| --- | --- | --- |
| Single transfer/unshield (Phase 1 payment + Phase 2 tx + amortized fee-redemption ~0.085) | ~0.18 | ~82% |
| 10-item batch, 2-output notes | ~0.90–1.12 | **break-even to LOSS** |

The client's `BATCH_MAX_ITEMS = 10` sits exactly at the underwater point: the
relay's worst-case legal job is its least profitable. That is an open griefing
invariant violation — a hostile (or merely thrifty) user can have the relay
inject at a loss all day.

A second consequence: because storage bytes are deterministic from the
client-built sapling transaction (spend/output counts are known before
submission), the true cost is **pre-quotable on the client** — there is no
oracle problem. We just never priced it.

## 2. Proposed model: quantized linear schedule

```
fee(txCount) = quantizeUp(baseMutez + perTxMutez × txCount, quantumMutez)
```

Recommended starting parameters (calibrated to the measured costs above). The relay
**ships dark** — these are the values an operator *sets* to enable the schedule; the
code defaults reproduce today's flat fee exactly (§3.5):

| Parameter | Value | Rationale |
| --- | --- | --- |
| `baseMutez` | 300_000 (0.30 XTZ) | ≥ 1.2 × the worst-observed Phase-1 payment op (~215k) — the per-job fixed cost; see §6.1 |
| `perTxMutez` | 270_000 (0.27 XTZ) | ≥ 1.2 × the worst-observed per-tx cost (~215k) so an all-max-fragmentation batch still clears a ≥20% profit floor; see §6.1 for the dial |
| `quantumMutez` | 250_000 (0.25 XTZ) | privacy quantization — see §4 |

Resulting tier table (quantize **up**, never down):

| txCount | raw (XTZ) | charged (XTZ) | est. cost | margin |
| --- | --- | --- | --- | --- |
| 1 | 0.40 | **0.50** | ~0.18 | ~64% |
| 2 | 0.55 | **0.75** | ~0.27 | ~64% |
| 3 | 0.70 | **0.75** | ~0.36 | ~52% |
| 5 | 1.00 | **1.00** | ~0.54 | ~46% |
| 10 | 1.75 | **1.75** | ~0.99–1.12 | ~36–43% |

Singles get *cheaper* than today (0.50 vs 1.00) while the batch cap becomes
solidly profitable. Note the whole table collapses to only a handful of
distinct on-chain-visible values: {0.50, 0.75, 1.00, 1.25, 1.50, 1.75} — that
is deliberate (§4).

## 3. Protocol changes (`shield-relay/1` → additive, not breaking)

### 3.1 Quote at `POST /get-worker-info`

The client already knows its item count before requesting worker info. Add an
optional request body:

```jsonc
{ "txCount": 3 }   // omitted by legacy clients
```

**`txCount` is defined precisely as the number of sapling transactions the client
WILL submit in Phase 2 — `sum(txns.length)` across the `userTransaction` payload,
computed by the client from the params it builds.** Count the *expanded* sapling
txs (including any note-management splits), not the UI item count. This is the exact
value the relay re-counts and enforces in §3.3, so the client must request a quote
for the count it will actually submit (see the correctness note there). Because the
spend/output bytes are deterministic from the built params, the client always knows
this number before it pays — there is no oracle problem.

`Processor.getWorkerInfo()` (`src/runtime/processor.ts`) computes
`quotedFeeMutez = schedule(txCount)` and:

- stores `quotedFeeMutez` **and** `quotedTxCount` on the job row (new columns,
  written in the same `store.createJob` call — the quote must be durable, it is
  what Phase 1 verification checks after a restart);
- returns them in the response alongside the existing fields. The response
  already carries `paymentAmount` as a string — keep that field but make it the
  *quoted* amount, so a schedule-aware client needs no new parsing.
- additionally returns the raw schedule
  (`feeSchedule: { baseMutez, perTxMutez, quantumMutez }`) so clients can show
  a fee preview *before* hitting the endpoint (e.g. while the user builds a
  batch).

**No `txCount` in the request** → legacy path: quote `PAYMENT_AMOUNT_MUTEZ`
(flat 1 XTZ) and mark the job `legacyQuote = true`. See §5 for the cap that
makes this safe.

### 3.2 Verify at Phase 1 — already 90% built

`verifyPaymentMemo(sdk, memo, expectedMutez)` (`src/core/payment.ts`) already
does an integer-mutez `receivedMutez >= expectedMutez` check. The only change:
the processor passes the job's stored `quotedFeeMutez` instead of the global
`PAYMENT_AMOUNT_MUTEZ` (`src/runtime/processor.ts`, the
`verifyPaymentMemo(worker.sdk, job.memo, …)` call).

### 3.3 Enforce at Phase 2 — **before** injection

`submitUserTransaction` counts the actual sapling txs in the submitted payload
(`sum(txns.length)`) and rejects with a 4xx **before enqueueing** if
`actualTxCount > job.quotedTxCount`. This closes the obvious dodge (quote for 1,
submit 10).

Two **fee-config-independent** invariants back this up (they hold even on a dark
relay, so under-pricing can't be turned into unbounded loss):
- **Phase 1 is capped at exactly one sapling tx** — a legitimate payment is a single
  shielded transfer to the worker, so extra txns stuffed into the *payment* (which the
  relay would broadcast at storage cost while only the memo'd value is credited) are
  rejected.
- **Phase 2 has a hard absolute cap** (`MAX_INJECT_TXS`, currently 32) on total
  submitted txns, independent of the fee schedule — a backstop against a cost-bomb that
  the per-config `LEGACY_FLAT_MAX_TXS` (off by default) doesn't cover.

A non-positive effective fee base is also rejected at config load (it would make
`received ≥ quoted` vacuously true — free injection).

**The cost of a mis-quote falls on the client, and there is no top-up.** By Phase 2
the user has already paid Phase 1 — the memo is consumed and the job is
`payment_confirmed`. The single-payment-per-job model has no channel to add to an
existing job's fee (a second payment is a different memo/job), so a rejected job
**forfeits the prepaid fee**. The rejection therefore protects the *relay* from the
griefing dodge, but a too-low quote is a *client bug* that costs the *user* a fee.
This makes **client-side exactness a hard correctness requirement**: the client MUST
request the quote for the exact `txCount` it will submit (§3.1). The relay's error is
explicit ("batch has 10 sapling txs but the paid fee covers 3"); it does not attempt
a resumable top-up (that would need a multi-payment protocol — explicitly out of
scope for v1, noted in §6). An over-cautious client may quote slightly high and
submit fewer — that is always fine:

Submitting *fewer* txs than quoted is allowed (the user overpaid by their own
choice; do **not** refund — refunds would create an amount-correlation channel).

### 3.4 Publish in the relay descriptor

When `GET /.well-known/shield-relay.json` lands (DESIGN.md blueprint), the
schedule belongs in it:

```jsonc
{
  "protocol": "shield-relay/1",
  "feeSchedule": { "baseMutez": 300000, "perTxMutez": 270000, "quantumMutez": 250000 }
}
```

This is what makes a future multi-relay client able to show fees without
creating a job — and it keeps the network's "sort by trust, never by fee"
stance honest, because fees are public and comparable but not the ranking key.

### 3.5 Config — ships dark by default

The defaults reproduce **today's exact flat behavior**, so upgrading a relay never
silently changes its pricing or which jobs it accepts. The operator opts into the
schedule by setting the recommended values (§2).

```
                       DARK DEFAULT (= today)     RECOMMENDED (opt-in, §2)
FEE_BASE_MUTEZ         = PAYMENT_AMOUNT_MUTEZ      300_000
FEE_PER_TX_MUTEZ       = 0                         270_000  (§6.1: ≥20% profit floor)
FEE_QUANTUM_MUTEZ      = 1   (no quantization)     250_000
LEGACY_FLAT_MAX_TXS    = 0   (no cap)              5  (see §5)
```

With the dark defaults, `schedule(txCount) = quantizeUp(PAYMENT_AMOUNT + 0×txCount, 1)
= PAYMENT_AMOUNT` for every `txCount`, and the legacy Phase-2 cap is off — byte-for-byte
the current relay. `PAYMENT_AMOUNT_MUTEZ` remains the legacy (no-`txCount`) quote in
both modes. Enabling the schedule and enabling the legacy griefing cap
(`LEGACY_FLAT_MAX_TXS=5`) are the operator's two deliberate switches.

## 4. Why quantized: the fee-redemption fingerprint

The fee payment itself is a shielded transfer (zet → worker zet) — its amount
is **not** public. But the redemption leg is: `refillWorkerGas`
(`src/core/gasRefill.ts`) unshields the worker's **entire accumulated sapling
balance** to its public tz1, and unshield boundary amounts are visible
on-chain.

With exact per-byte pricing, that unshield amount is a subset-sum over a large
set of distinct per-job fees — frequently decomposable, letting a passive
observer recover the relay's job-shape mix (and, with timing, sometimes
individual jobs). With 0.25-quantized fees, every redemption amount is a
multiple of 0.25 XTZ composed from ~6 possible values — the decomposition is
maximally degenerate and the observer learns little beyond "n jobs, roughly".

Two cheap hardenings to adopt alongside (both already consistent with the
gas-refill design):

1. **Threshold-triggered, not schedule-triggered** redemption (already true:
   refill fires on gas balance, not a timer tick per job).
2. **Leave a random remainder**: unshield
   `balance − uniform(0, 2 × quantum)` rounded to the quantum instead of the
   full balance, so consecutive redemptions don't telescope into an exact
   running sum. One-line change in `refillWorkerGas`; costs nothing.

The same logic is why the schedule should stay **coarse**. Resist per-byte or
per-output precision: every extra distinct fee value is anonymity-set
fragmentation in the redemption stream. The headroom in `perTxMutez` is the
price of privacy, and at ~40–60% margins it is affordable.

## 5. Back-compat and rollout

The deployed clients (V2 root + legacy) pay a hardcoded flat 1 XTZ and never
send `txCount`. The v3 client hardcodes `RELAY_FEE_XTZ = 1`
(`src/app/core/bridge/engine.ts` in shield-bridge). None of them break:

1. **Relay ships dark** (defaults reproduce flat pricing, §3.5).
2. **Flip the schedule on** (operator sets §2's values incl. `LEGACY_FLAT_MAX_TXS=5`,
   the point where flat 1 XTZ still clears cost). Legacy (no-`txCount`) jobs keep
   being quoted — and paying — the flat 1 XTZ unchanged; the only new behavior is
   that a legacy client submitting a 6–10-item batch gets a clean 4xx before injection
   with a "please update" message. This converts the silent *relay* loss into an
   explicit, harmless error for the rare large-batch legacy user. **No existing user
   pays more than they do today.**
3. **Clients adopt the quote.** shield-bridge changes, in order:
   - read `paymentAmount` from the `get-worker-info` response instead of the
     hardcoded constant (the response field already exists — today's clients
     just ignore it in favor of the constant);
   - send `txCount` (single ops send 1; `useBatch` knows its valid-item count);
   - surface the quoted fee in the existing fee rows (Bridge single-form fee
     row, batch cart fee row, ScanToPay "Via" row) — all three currently
     render the `RELAY_FEE_XTZ` constant, so this is a presentation swap, not
     new UI;
   - use `feeSchedule` from the descriptor for the pre-submit preview while
     building a batch (live "Relay fee: 0.75 XTZ" as rows are added).
4. **Eventually** drop `LEGACY_FLAT_MAX_TXS` once flat-fee client traffic is
   gone (observable: jobs with `legacyQuote = true` per week → 0).

The benefit lands on **two distinct timelines** — don't conflate them:

- **Day one (schedule enabled, all clients):** the *relay* stops bleeding. Underwater
  large batches are refused (`LEGACY_FLAT_MAX_TXS`) instead of injected at a loss; the
  griefing invariant is closed. Existing clients pay exactly what they pay today.
- **After client adoption (updated clients only):** *users* pay less. A single drops
  1.00 → 0.50 and batches are priced fairly. This is the "no fee increase, ever"
  adoption story — singles stop subsidizing batches and vice-versa — but it requires
  the client to send `txCount` and read `paymentAmount` (§5.3); a legacy client never
  sees the discount, it just keeps paying the flat 1 XTZ it always did.

So enabling the schedule is safe and griefing-closing on day one regardless of client
state; the user-facing price drop follows whenever the client ships.

### 6.1 Empirical storage-burn sweep (2026-06) — resolves Q1

Method: 50 applied, storage-bearing sapling operations on a live mainnet Set
contract (`KT1KzAPQdpziH3bxxJXQNmNQA46oo8tnDQfj`), pulled from TzKT, plus the
known 10-asset relay batch (`ooRSpM5…`). Per-op figures:

| metric | p50 | p75 | p90 | p95 | max | mean |
|---|---|---|---|---|---|---|
| storage (bytes) | 339 | 646 | 678 | 710 | 838 | 428 |
| storage burn (µtz) | 84,750 | 161,500 | 169,500 | 177,500 | 209,500 | 106,945 |
| gas used | 30,229 | — | — | — | 81,727 | — |

- **`cost_per_byte = 250 µtz` confirmed** (storageFee ÷ storageUsed = 250 on every op).
- The distribution is **bimodal**: a ~p50 single-input cluster (~339 B / ~85k µtz) and a
  heavy tail of multi-input / 2-output ops (~646–838 B / 161k–210k µtz). **26% of real ops
  burn more than 150,000 µtz in storage alone** — so the original placeholder
  `perTxMutez = 150k` is underwater for over a quarter of operations.
- Gas adds only ~5,500 µtz/op (a share of the op-group bakerFee); **storage dominates** (~94%),
  as the network-design estimate predicted.
- Per-tx TOTAL cost (storage + gas share): **p50 ≈ 90k, p90 ≈ 175k, max ≈ 215k µtz.**
- **Phase-1 payment is itself a sapling unshield** (the fee → worker tz1), so it carries the
  same ~85k+ storage burn. `baseMutez` must cover it (it's the per-job fixed cost), not `perTxMutez`.

**Sizing for a ≥20% profit floor (operator goal).** A job is `n+1` sapling ops (1 Phase-1
payment + n Phase-2). Worst observed full per-op cost (storageFee + bakerFee) = **214,729 µtz**
over the 50-op sweep, so an *all-max-fragmentation* batch costs `C(n) = 215k·(n+1)`. For
`fee(n) ≥ 1.2·C(n) = 258k·(n+1)` at every n (the fee is linear in n, the cost too), both
coefficients must clear 258k: **`baseMutez ≥ 258k` and `perTxMutez ≥ 258k`.**

**Recommendation: `baseMutez = 300,000`, `perTxMutez = 270,000`, `quantumMutez = 250,000`,
`LEGACY_FLAT_MAX_TXS = 5`.** Both clear 258k with margin, so ≥20% profit holds on the worst
*observed* op for any n (quantization only adds). Worked fees + the all-max profit floor:

| n | fee (XTZ) | all-max cost (XTZ) | profit | typical cost (p50) | typical markup |
|---|---|---|---|---|---|
| 1 | 0.75 | 0.43 | +74% | 0.18 | ~4× |
| 5 | 1.75 | 1.29 | +36% | 0.53 | ~3× |
| 10 | 3.0 | 2.36 | **+27%** | 0.98 | ~3× |

The floor is the all-max column (≥+27% at the n=10 cap). The cost of guaranteeing it is that
TYPICAL users pay ~3× their real cost — inherent to a fee that's linear in `txCount` (which
can't see an op's byte size at quote time). **This is a dial:** size `perTx`/`base` at
`1.2 × p50 (~107k)` instead for a fair ~20% markup on typical jobs, accepting the all-max batch
runs at a small loss; or at `1.2 × p90 (~210k)` for a middle ground. The values above pick the
worst-observed bound per the operator's "≥20% on the pathological batch" goal.

**Residual:** an op fragmented *beyond* the observed max (toward the 1.04M-gas per-op cap, where
storage could reach millions of µtz) still exceeds `perTxMutez` — the quote is on `txCount`, not
bytes, so this can't be priced out. Bounded by the gas cap + `MAX_INJECT_TXS`; rare; the user
prepaid. Tighten only if such ops actually appear.

## 6. Open questions

1. ~~**Note-shape variance.**~~ **Resolved — see §6.1.** A 50-op mainnet sweep showed a
   bimodal 76,750–209,500 µtz storage-burn range (not the original single 307–371-byte
   sample). `perTxMutez` set to **270k** (= 1.2 × the 215k worst-observed op) so the operator's
   ≥20%-profit-on-the-all-max-batch goal holds; `baseMutez` 300k.
2. **XTZ vs FA-token pools.** The measured op mixed pools; gas differs (XTZ
   set ~82k vs ~31k) but storage — the dominant term — does not vary much by
   pool. Proposal treats all pools identically; revisit only if a measured
   gap exceeds the quantum.
3. ~~**Should `txCount` count sapling txs or contents?**~~ **Resolved (§3.1):**
   `txCount` = the expanded number of sapling txs the client will submit
   (`sum(txns.length)`), since storage burn scales with those and the relay
   enforces on exactly that count. Note-management splits count toward it; the
   client builds the params, so it always knows the number before it pays.
4. **Enabling `LEGACY_FLAT_MAX_TXS` mid-flight.** A legacy job already
   `payment_confirmed` under no cap, whose Phase-2 batch exceeds a cap the operator
   enables before it submits, is rejected — forfeiting the already-paid fee. The
   window is narrow (a config change during one job's Phase-1→Phase-2 gap) and the
   absolute `MAX_INJECT_TXS` backstop is *not* runtime-toggled, so it never surprises
   in-flight jobs. Recommendation: enable the legacy cap during low traffic; no
   grandfather mechanism in v1.
5. **Quote TTL.** The quote is pinned to the job row and jobs already expire
   (`JOB_TTL_SECONDS`); no separate quote expiry is needed unless schedule
   changes mid-flight become common. Recommendation: schedule changes only
   apply to new jobs; stored quotes are honored until job expiry.
