# Protocol (written before the first scored run; not changed after)

Written 2026-11-03, before any handler was run on real data. What I had looked at before writing it: the size of the data files, the event types in them, and how many pull requests have two or more state events (36 of 76, no ties between opposite states). I had not run either handler on any real vector or stream.

If a number in this folder's results needs a different rule than the one written here, the rule stays and the difference is reported as a deviation in README.md.

## What is real and what is mine

Real: the signature test vector from GitHub's docs, the payload examples from octokit/webhooks, the Stripe signing scheme and its test constants, and the public GitHub event records (ids, timestamps, types, repo names, PR numbers, per-PR close/reopen/force-push history).
Mine: the handicaps below (how often events are duplicated, delayed, reordered or fail), the way real events are mapped into the lab's event shape, and every Stripe-style signature on a GitHub payload.

## Part 1. Signature vectors

Handlers: `src/broken.js` (`makeBrokenHandler`) and `src/fixed.js` (`makeFixedHandler` and its exported `verify`). Secret for lab-scheme signing: `whsec_test_synthetic`. Clock for the fixed handler: a fixed integer `NOW = 1800000000`.

1. GitHub doc vector. Secret `It's a Secret to Everybody`, payload `Hello, World!`, expected `sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17`.
   - V1a: Node `createHmac('sha256', secret).update(payload)` hex equals the documented value.
   - V1b: `verify()` called with the GitHub header (`sha256=...`) and the same secret. Expected by design: false, because the lab only implements the Stripe-style header. This is recorded as a coverage gap, not a defect.
2. Stripe scheme, using stripe-node's test constants (secret `whsec_test_secret`, payload `JSON.stringify({id:'evt_test_webhook',object:'event'}, null, 2)`). The header is built by the documented recipe (`t=<ts>,v1=HMAC_SHA256(secret, "<ts>.<payload>")`). A second implementation in Python (`hmac`, `hashlib`) must produce the same hex; if not, the run stops.
   Cases against the fixed `verify()` (expected result in brackets):
   - S-valid: t = NOW (accept)
   - S-age299: t = NOW-299 (accept); S-age300: t = NOW-300 (accept, boundary); S-age301: t = NOW-301 (reject)
   - S-future301: t = NOW+301 (reject by the lab's rule; stripe-node would accept, see README)
   - S-tamper: one byte of the payload changed (reject)
   - S-wrongsecret: signed with a different secret (reject)
   - S-v0only: header with only a `v0=` signature (reject, downgrade protection)
   - S-rotation: header with two `v1` values, one made with the right secret (accept)
   - S-docs-header: the example header from Stripe's docs (`t=1492774577,v1=5257...,v0=6ffb...`), checked at the time t (reject, no key for it, and it must not throw)
   - S-nohex: `v1=` value of 64 non-hex characters (reject)
3. Real payload bytes. The 12 octokit payload files listed in SOURCES.md are signed with the Stripe-style scheme over their exact bytes. For each file the same six checks run through `verify()` : valid, tampered (one byte flipped at the middle), wrong secret, stale (NOW-3600), future (NOW+3600), and a payload with one trailing space appended after signing.
4. End to end through both handlers. Each octokit payload is wrapped as a lab event (`id`=`octokit-<file>`, `type`=`invoice.paid`, `created`=NOW, `data.customer`=`octokit-<file>`, `data.amount`=1, `data.payload`=the real payload object) and delivered with the five cases valid, tampered, wrong secret, stale, forged-zero-MAC. A delivery counts as "accepted" when the handler returns status 200 and the balance for that customer changed. Expected for the fixed handler: only valid accepted. The broken handler has no signature check; its row is reported as measured.
5. Constant-time compare: checked by reading `src/fixed.js` for `timingSafeEqual`, and by the existing mutant "constant-time MAC compare removed" being killed by the suite. It is not measured by timing.

## Part 2. Real event streams

Data: GitHub events from six public repositories (REST `GET /repos/{owner}/{repo}/events`, up to 10 pages of 30) and the issue-events timeline of the 141 pull requests seen in them. Fetched 2026-11-03 with the authenticated `gh` CLI, read only. Frozen in `data/events-frozen.jsonl.gz` with actors, logins, titles and bodies dropped.

Mapping into the lab's event shape (`scripts/lib/stream.mjs`):
- Counter event: every Events API record that is not a lifecycle record of a PR with a timeline, plus every timeline `head_ref_force_pushed` (the nearest real thing to the "synchronize" action; the events API does not list plain pushes to a PR). It becomes `invoice.paid`, `amount` 1, one unique customer per event (`c-<id>`). Applied-count per event is then the customer's balance: 0 means dropped, 2 or more means processed more than once.
- State event: PR `opened` (Events API) and `reopened`, `closed`, `merged` (timeline). Opened and reopened become `subscription.activated` (truth: open); closed and merged become `subscription.canceled` (truth: closed). The customer is `pr-<repo>#<number>`. Events API records with action `closed`, `merged` or `reopened` for PRs that have a timeline are dropped, because the timeline holds the same fact with its own id.
- Ids are prefixed `ev-` (Events API) or `ie-` (timeline) so the two id spaces cannot collide.
- Ground truth for a PR: the state of its last state event by timestamp. A PR is "ambiguous" if any one second holds events that lead to opposite states; ambiguous PRs are excluded from the headline and counted. A PR is "scorable" if it has 2 or more state events and is not ambiguous.
- Simulated clock: whole seconds. The signature time `t` is the second the delivery is sent. The receiver's `now` is the second it arrives.

Seeded generator: mulberry32. Scenario k uses seed `20261103 + k`. Every random choice is drawn in a fixed order from that generator.

Scenarios (all handicaps are my invention):
- S0 clean: each event once, in order of (created, id), sent and received at `created`.
- S1 duplicates: each event gets one extra copy with probability 0.30; each of those gets a second extra copy with probability 0.20. Extra copy i is sent at `created + i * (1 + floor(rand*30))` and signed with its own send time (as a provider that re-signs on retry does).
- S2 reorder: each event is delayed with probability 0.30 by a whole number of seconds drawn uniformly from 1 to 250. Signed at `created`, received at `created + delay` (always inside the 300 s window).
- S3 reverse: S0, but for every PR with 2 or more state events the order of its state events is exactly reversed among the same time slots. Worst case for ordering; every sequence is hit.
- S4 long delay: each event is delayed with probability 0.10 by 301 to 7200 seconds, signed at its arrival (a provider retry with a fresh signature).
- S5 burst: S0 plus the duplicates of S1, delivered in concurrent groups. A group is all deliveries whose arrival second falls in the same 10-second bucket; all calls in a group start together with `Promise.all`.
- S6 transient failure: 5% of events fail once (`failOnce`). S6p: 1% of events fail every time (a `failOnce` set whose `delete` does nothing).
- S7 everything: the duplicates of S1, the reordering of S2, the long delays of S4 and the transient failures of S6, delivered in the bursts of S5.
- S8 stale replay: S0, plus 10% of events replayed with their original bytes and original header (`t` = created) after 301 to 7200 seconds. The fixed handler is expected to reject every replay.

Metrics, per scenario and handler:
- `dup_extra`: sum over counter events of max(0, applied - 1).
- `dropped`: counter events applied 0 times. In S6p, also how many were acknowledged with status 200 (silently lost) versus status 500 with a dead-letter record.
- `wrong_final_all`: PRs (all with a state event) whose final stored state differs from truth. `wrong_final_multi`: same, on the scorable PRs only. This is the headline for ordering.
- `stale_overwrites`: times a stored PR state was replaced by an event with an older `created`.
- `accepted`, `rejected`: status 200 and 400 counts, for sanity.
- Replay (S8): `replays_accepted` = replayed deliveries answered 200 whose application changed a balance.

Pass condition I expect before seeing results: the fixed handler scores 0 on `dup_extra`, `dropped`, `wrong_final_*` and `stale_overwrites` in every scenario except S6p (where it should dead-letter and answer 500) and S8 (where it should reject all replays). The broken handler should score above 0 in S1, S3, S5, S6, S8. If the fixed handler does not meet this, that is a finding, reported as is.

## Part 3. Backoff with jitter

Take the real second with the most events in the base stream (N events). All N fail every attempt (`failOnce` with a no-op `delete`), `maxAttempts` 5. Three configurations of the fixed handler, each recording the delays requested through `sleep`: (a) default `backoffMs` (zero), (b) exponential with no jitter, `100 * 2^attempt` capped at 5000, (c) `expBackoffJitter(100, 5000, rand)` with seeded `rand`. Report: every delay inside its allowed range; distinct delay values; the largest number of retries whose first-round delay falls in the same 50 ms bucket. This tests the helper and the handler's use of it, not the timing of a real network.

## Gates after any change to `src/`

`npm test` (35 tests), `node scripts/broken-raw.js`, `python3 scripts/mutate.py`. If a bug is found: failing test first, then the fix, then a new mutant for it, then all three gates again.
