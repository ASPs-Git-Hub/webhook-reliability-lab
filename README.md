# Webhook Rescue Lab

**Independent technical demonstration. The tests use made-up events on purpose; the main results use real public data (see `real-data/`). Not client work and not production experience.**

**Version note: this repository is version 2 of Webhook Rescue Lab, published with a clean history. The earlier repository, `webhook-rescue-lab`, holds version 1 (14 tests, 5 planted defects, no real-data run).**

Status: **BUILT_UNVERIFIED**: tests and planted-defect checks were run by me locally on 2026-11-03 (Node v26.0.0); remote CI has not yet run on the latest changes. This repository has just been created, so the first CI run is pending. No outside person has checked the results. The lab was reviewed by two independent AI reviewers (ChatGPT and Claude Fable) and corrected. Not reviewed by a human engineer. Raw output is in `evidence/` and `real-data/evidence/`.

## Real-data results
Full write-up, rules and raw output: [`real-data/README.md`](real-data/README.md). Real data: 1,941 real GitHub events from 6 public repositories, plus GitHub's and Stripe's published signature examples. How often events arrive twice, late or fail is my invention (written down before the run).

| Test (broken handler / fixed handler) | Broken | Fixed |
|---|---|---|
| Events processed twice (30% sent twice) | 686 | 0 |
| Old signed messages replayed later: accepted | 215 of 215 | 0 of 215 |
| Events that failed for good: told the sender "200 OK" | 31 | 0 |
| Events that failed for good: answered with an error (500) | 0 | 32 (the 31 plus one pull request state event) |
| Pull requests left in the wrong final state (events in reverse order) | 5 of 36 | 0 of 36 |

- The fixed handler lost the same 31 events the broken one did, because I made them fail every time. The difference is that it said so, and kept a record.
- The fixed handler reads Stripe-style signatures only. It does not understand GitHub's `sha256=` header, so it rejects a real GitHub signature. That is a gap in the lab.
- I found no bug in `src/` in this run, so nothing was changed there.
- Real pull request events are usually minutes apart, so mild reordering barely hurt the broken handler.

## Problem
A payments-style webhook consumer that looks fine in testing but fails in production: forged or replayed requests are accepted, duplicate deliveries double-credit, late or same-second events overwrite newer state, malformed payloads crash or corrupt data, and a transient error silently loses the event.

## Layout
- `src/broken.js` the defective handler.
- `src/fixed.js` the repaired handler:
  - Stripe-style signature header (`t=<unix seconds>,v1=<hex HMAC-SHA256>`, several `v1` values and several secrets allowed for rotation); strict format checks; constant-time compare; replay window of 300 seconds in both directions; fails closed on a broken clock.
  - Payload validation before anything else (400 on malformed input, no retry storm).
  - Event-id idempotency, including concurrent duplicates, who all receive the first attempt's real outcome.
  - Deterministic ordering: later `created` wins; within the same second the event id breaks the tie so arrival order cannot change the result.
  - Bounded retries with an injectable backoff hook (a full-jitter helper, `expBackoffJitter`, is included), a failure list with one record per event, and a security log hook for rejected and dead-lettered deliveries.
- `test/lab.test.js`: 35 tests. Twelve contracts run against both handlers (the broken one must fail each with the intended defect); the rest cover the fixed handler's edge cases.
- `scripts/broken-raw.js` prints the real defect for each of the twelve contracts.
- `scripts/mutate.py` plants 24 defects in `fixed.js` one at a time and requires the suite to fail each time.

Run: `npm test`, `node scripts/broken-raw.js`, `python3 scripts/mutate.py` (Node 20+, Python 3, no dependencies).

## Evidence (executed 2026-11-02, output in `evidence/`)
- `fixed-and-contract-run.txt`: 35 tests, 35 pass (rerun 2026-11-03 for version 2: 35 of 35).
- `broken-defects.txt`: 12 of 12 contracts fail on the broken handler, each shown with its real defect.
- `mutation-run.txt`: 24 of 24 planted defects detected. The list of what was planted is the `MUTATIONS` table in `scripts/mutate.py`.

## Review history
Round 1 independent review (ChatGPT and Claude Fable, working separately, same commit) found real defects in the first version: the forged-signature test could not fail (the replay check rejected the request first), concurrent duplicates of a failing event were told "success", same-second events were dropped, `null` or id-less events crashed or merged, string amounts were concatenated, a valid signature with trailing garbage was accepted, a broken clock accepted stale requests, and `maxAttempts: 0` skipped processing. All were reproduced and fixed in this version, each with a test.

## What this does NOT prove
- Real provider behaviour. The header format is Stripe-style but this code has not been checked against Stripe's or any provider's live webhooks. Providers differ in header format, retry schedule and ordering.
- Durability. Idempotency records and the failure list are in memory: they are lost on restart, are not shared between workers, and grow without bound. Production needs a unique index written in the same database transaction as the business update, a durable queue and a retention policy.
- Within-second ordering is deterministic but arbitrary (event id); Stripe's documentation says not to order events by `created`. A real system needs the provider's sequence number or a fetch of current state.
- Processing is inline. The handler applies the business update and its retries before it replies. Stripe's and GitHub's guidance is to acknowledge quickly and process asynchronously from a durable queue; retrying inline on top of the provider's own retries also amplifies load (AWS Builders' Library, Google SRE book).
- Idempotency is keyed on the event id only (Stripe notes that separate Event objects can carry the same underlying object), and the "done" mark is not written atomically with the side effect, so a crash between them can double-apply.
- No HTTP layer. Raw-body capture, real status codes and response deadlines are not demonstrated; the handler is called with a string.
- Retries are immediate unless a backoff function is supplied (the tests inject one), and permanent errors are not distinguished from transient ones.
- Load, security review by a human, and any production outcome.
- Real-data limits: the real events are one morning from 6 repositories, and only 36 pull requests carry the ordering result. My duplicate, delay and failure rates are my choices. The GitHub-to-lab event mapping is a stand-in, and every Stripe-style signature on a GitHub payload is mine. No HTTP server, no live GitHub or Stripe delivery. No tie in the same second ever happened, so the tie-break was not tested on real data.
