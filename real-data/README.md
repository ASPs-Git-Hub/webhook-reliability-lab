# Webhook Rescue Lab: tests with real public data

**Independent technical demonstration. Real public data, my own test conditions. Not a client result and not production experience.**

Status: executed locally on 2026-11-03 with Node v26.0.0. Not yet run in CI and not reviewed by another person. The existing 35 tests and 24 planted-defect checks in the lab still pass after this work (`evidence/gates-after-realdata.txt`). I changed nothing in `src/`.

## What this is, in plain words

A webhook is a message one service sends to another when something happens. GitHub sends one when someone opens a pull request. Stripe sends one when a payment goes through.

The lab has two programs that receive these messages. `broken.js` trusts everything. `fixed.js` checks each message before it acts. Until now I tested them only with made-up messages. This folder tests them with real ones.

Four ideas matter here:
- **Signature.** The sender mixes the message with a secret key and attaches the result. The receiver does the same sum. If the two results differ, someone changed the message or does not know the key.
- **Replay.** An attacker saves a real message and sends it again later. A time stamp inside the signature lets the receiver say "too old".
- **Idempotent.** Doing the same thing twice gives the same result as doing it once. A receiver needs this because senders often send a message twice.
- **Backoff with jitter.** After a failure, wait before trying again. Jitter means each waiter picks a slightly different wait, so they do not all come back at the same moment.

## What is real and what is mine

Real: GitHub's published signature example, 12 payload examples from the octokit project, Stripe's signing recipe and test constants, and 1,740 public GitHub events with their real ids and times, plus the real close and reopen history of 141 pull requests.

Mine: how often I make events arrive twice, late, out of order or fail. Those numbers are my invention (see `PROTOCOL.md`, written before the first run). Also mine: the way I turn a GitHub event into the lab's event shape, and every Stripe-style signature on a GitHub payload. GitHub itself does not sign that way.

Sources, licences and fetch dates are in `SOURCES.md`.

## What I ran

```
cd real-data
node scripts/vectors.mjs    # Part 1, writes evidence/vectors-run.txt
node scripts/replay.mjs     # Part 2, writes evidence/replay-run.txt and replay-results.json
node scripts/backoff.mjs    # Part 3, writes evidence/backoff-run.txt
```

Everything runs on this machine. No server was opened. Needs Node 20 or newer and Python 3 (for one cross-check). No new packages.

## Part 1. Signatures

| Check | Result |
|---|---|
| GitHub's example: the lab's HMAC-SHA256 gives the documented value | pass |
| GitHub's header format given to the fixed `verify()` | rejected. The lab only understands the Stripe-style header. This is a gap in the lab. |
| Stripe-style: valid, 299 s old, exactly 300 s old | accepted |
| Stripe-style: 301 s old, 301 s in the future, changed byte, wrong secret, only a `v0` signature, 64 non-hex characters, header copied from Stripe's docs | rejected |
| Two `v1` values, one right (secret rotation) | accepted |
| 12 real payloads, fixed `verify()`: valid, changed byte, wrong secret, 1 hour old, 1 hour in the future, a space added at the end | 12 of 12 correct in each of the 6 cases (84 checks including the checksum of each file) |
| 12 real payloads end to end, fixed handler | valid accepted 12 of 12; changed, wrong secret, stale, forged zeros accepted 0 of 12 |
| 12 real payloads end to end, broken handler | valid accepted 12 of 12; changed, wrong secret, stale, forged zeros **accepted 12 of 12 each** |
| Constant-time compare | present in `fixed.js` (`timingSafeEqual`). I read the source. I did not time it. |

110 rows ran; 106 matched what I expected. The 4 that did not are the broken handler accepting forged messages, which is the defect it was built to show. Full list: `evidence/vectors-run.txt`.

Stripe publishes no fixed secret, message and signature triple. The Stripe header here comes from the documented recipe applied to stripe-node's test constants. A second program in Python gave the same hex string, so the recipe is implemented the same way twice.

One difference from Stripe's own library: stripe-node rejects a time stamp that is too old but accepts one in the future. The lab rejects both. The lab is stricter. If a provider's clock runs more than 5 minutes ahead, the lab would refuse real messages.

## Part 2. Real event streams with my handicaps

Base stream: 1,941 events (1,819 counted events and 122 pull request state events), 76 pull requests. 36 of them have two or more state events and no second where opposite states meet. Those 36 are the ones I score for "final state".

How the events are used:
- A counted event adds 1 to its own counter in the lab. A counter at 2 means the event was processed twice. A counter at 0 means it was lost.
- A state event sets a pull request to open (`opened`, `reopened`) or closed (`closed`, `merged`). The true final state is whatever the real last event says.

Numbers are for broken / fixed. "Wrong final state" is out of the 36 scored pull requests.

| Scenario (my handicap) | Processed twice | Lost | Wrong final state | Older event overwrote newer |
|---|---|---|---|---|
| S0 clean order, no handicap | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| S1 duplicates (30% twice, some three times) | 686 / 0 | 0 / 0 | 0 / 0 | 2 / 0 |
| S2 reorder (30% of events up to 250 s late) | 0 / 0 | 0 / 0 | 0 / 0 | 1 / 0 |
| S3 reverse (each PR's state events in exact reverse) | 0 / 0 | 0 / 0 | **5 / 0** | 19 / 0 |
| S4 long delay (10% of events 5 minutes to 2 hours late, fresh signature) | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| S5 bursts (duplicates, sent in groups of 10 seconds, concurrently) | 617 / 0 | 0 / 0 | 0 / 0 | 2 / 0 |
| S6 one-time failure (5% of events) | 0 / 0 | 83 / 0 | 0 / 0 (overall, all 76 PRs: 1 / 0) | 0 / 0 |
| S6p permanent failure (1% of events) | 0 / 0 | 31 / 31 | 0 / 0 (1 of 76 overall, both) | 0 / 0 |
| S7 all of S1, S2, S4, S6 together, in bursts | 600 / 0 | 66 / 0 | 1 / 0 | 1 / 0 |
| S8 old signed messages replayed 5 minutes to 2 hours later | 207 / 0 | 0 / 0 | 2 / 0 | 2 / 0 |

More detail:
- S6p: the broken handler answered "200 OK" for all 31 lost counted events, so the sender would never retry. The fixed handler answered 500 for the 32 failing messages (one was a state event) and kept a record of each. Both lose the same events for good because I made them fail every time. The difference is that the fixed one says so.
- S8: the broken handler accepted all 215 replays. The fixed handler rejected all 215 because the signature time was too old.
- S5 and S7: 98 copies of the same event landed in the same 10-second group, so some duplicates were really in flight at the same moment. I counted this after the run with a second script.
- Every scenario used a fixed random seed, so the run can be repeated. Same data and same seed give the same numbers.

## Part 3. Backoff with jitter

The busiest real second in the stream had only 8 events. I made all 8 fail every time, with 5 attempts each.

| Wait rule | Delays within allowed range | Different first waits | Most retries in the same 50 ms |
|---|---|---|---|
| none (the default) | yes | 1 | 8 |
| exponential, no jitter | yes | 1 | 8 |
| `expBackoffJitter`, seeded | yes | 8 | 3 |

This shows the helper spreads retries and the handler calls it between attempts. With 8 events it says little about a real retry storm.

## What went wrong, or came out weak

- **No bug found in `src/`.** The fixed handler met every expectation I wrote down in advance. So nothing was changed, no new planted-defect check was added, and there is no before and after.
- **The lab cannot check GitHub's own signature header.** It only knows the Stripe-style one. Also, GitHub's signature has no time stamp, so a replay window like the one in the lab cannot be applied to GitHub messages.
- **Reordering barely hurt the broken handler on real data.** Real pull request events are usually minutes or hours apart, and my delays in S2 were at most 250 seconds. Only the forced reversal (S3) and the mixed run (S7) produced wrong final states. I did not tune the numbers to make this look bigger.
- **Only 36 pull requests carry the ordering result.** The five failures in S3 are 5 of 36. That is a small sample from one morning in six repositories.
- **Ties never happened.** No pull request had opposite states in the same second, so the lab's tie-break by event id was not tested on real data.
- **A stripe-style test vector could not be taken from Stripe as a fixed triple.** See Part 1.

## What this does not prove

- That the fixed handler works with a live GitHub or Stripe webhook. There is no HTTP server here, no raw request body capture, no response deadline.
- That my duplicate, delay and failure rates look like any real provider's. They are my choices.
- That the mapping from GitHub events to "invoice" and "subscription" events is how a real system would store them. It is a stand-in.
- Anything about durability. The fixed handler keeps its memory of seen events in process memory (see the main README).
- That the octokit payloads are captured deliveries. They are published examples.
- Load, long runs, or behaviour after a restart.

## Files

- `PROTOCOL.md` the plan, written before the first scored run. `SOURCES.md` sources and licences. `SHA256SUMS` checksums of data and scripts.
- `scripts/vectors.mjs`, `replay.mjs`, `backoff.mjs`, `freeze-events.mjs`, `stripe_ref.py`, `lib/stream.mjs`, `lib/rng.mjs`.
- `data/` frozen real data: 22,539 byte event file, 12 gzipped payloads, the two vector files. Total 84 KB.
- `evidence/` raw output of each run (`vectors-run.txt`, `replay-run.txt`, `replay-results.json`, `backoff-run.txt`) and the lab's own gates after this work (`gates-after-realdata.txt`).
