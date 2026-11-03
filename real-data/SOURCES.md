# Sources

All fetched 2026-11-03 (UTC). Downloads were data files only, saved to a scratch folder, parsed as data, never run. Requests were spaced 0.8 to 1.5 seconds apart.

| What | Where | Version / date | Licence | Used for |
|---|---|---|---|---|
| GitHub signature test vector (secret, payload, expected `sha256=` value) | https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries (source file `content/webhooks/using-webhooks/validating-webhook-deliveries.md` in github/docs) | fetched 2026-11-03 | github/docs: CC-BY-4.0 for content, MIT for code | Part 1, V1 |
| Stripe signing scheme and 5 minute default tolerance | https://docs.stripe.com/webhooks (markdown copy of the same page, section "verify signatures manually") | fetched 2026-11-03 | Stripe documentation, read only, only the scheme is described here | Part 1, V2 |
| Stripe test constants (`whsec_test_secret`, the test event) and tolerance behaviour | https://github.com/stripe/stripe-node, `test/Webhook.spec.ts` and `src/Webhooks.ts`, commit 6d5ed967d602224ac3056dc3f0befbb55487ee50 | fetched 2026-11-03 | MIT (GitHub licence API says MIT) | Part 1, V2 |
| 12 real webhook payload examples | https://github.com/octokit/webhooks, folder `payload-examples/api.github.com`, commit aa80c24a3f55354465b8b1438d33dd5602956d0d | fetched 2026-11-03 | MIT (GitHub licence API says MIT) | Part 1, V3 and V4 |
| Public repository events | GitHub REST API `GET /repos/{owner}/{repo}/events` (https://docs.github.com/en/rest/activity/events) for NixOS/nixpkgs, home-assistant/core, microsoft/vscode, rust-lang/rust, kubernetes/kubernetes, pytorch/pytorch; up to 10 pages of 30 each | 2026-11-03 07:26 to 07:29 UTC | GitHub API terms; only ids, times, event types, public repo names and PR numbers are kept | Part 2 |
| Public pull request timelines | GitHub REST API `GET /repos/{owner}/{repo}/issues/{number}/events` (https://docs.github.com/en/rest/issues/events) for 141 PRs seen in the events | 2026-11-03 07:29 to 07:34 UTC | same | Part 2 |

## The 12 octokit files (original sha256 in `data/octokit/ORIGINAL-SHA256.txt`)

`check_run/completed`, `issue_comment/created`, `issues/opened`, `ping/payload`, `pull_request/opened`, `pull_request/synchronize`, `pull_request/closed`, `pull_request/reopened`, `push/1`, `release/published`, `star/created`, `workflow_run/completed`. They are stored gzipped. The test unzips them and checks the sha256 of the bytes before using them. These are examples published by the octokit project. I did not capture them from live deliveries.

## What I ran to get the event data

`gh` was logged in; the calls only read public data. Event pages: `gh api "repos/$repo/events?per_page=30&page=$pg"` for pg 1 to 10, with a 1.5 second sleep. Timelines: `gh api "repos/$repo/issues/$num/events?per_page=100"` with a 0.8 second sleep, for 51 PRs that had an `opened` event plus 90 more taken in the order they appeared. I typed these in the shell. They are not saved as a script, so they are written here instead. `scripts/freeze-events.mjs` turns the raw responses into the small frozen file.

## What was kept from the event data

Event id, time in whole seconds, event type, action, public repo name, PR number. Dropped before anything was saved in this folder: actor names and ids, logins, avatar and other URLs, titles, bodies, labels, emails. The raw responses stay outside the repository.

The frozen file `data/events-frozen.jsonl.gz` has 2,116 lines: 1,740 unique events from the events API, 235 timeline records, and 141 marker lines that say which PRs had their timeline fetched. Size 22,539 bytes.

## Checksums

`SHA256SUMS` lists every file in `data/` and `scripts/`.
