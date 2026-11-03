// Reads the raw GitHub API responses (data only, never executed) and writes a small anonymised JSONL.
// Usage: node freeze-events.mjs <rawEventsDir> <outFile.jsonl.gz>
// Kept per record: source, event id, unix seconds, kind, action, public repo name, PR number. Dropped: actors, logins, emails, titles, bodies, URLs.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';

const [raw, out] = process.argv.slice(2);
const ts = (s) => Math.floor(Date.parse(s) / 1000);
const files = readdirSync(raw).filter((f) => /_p\d+\.json$/.test(f)).sort();
const seen = new Set();
const recs = [];
const prs = new Set();
for (const f of files) {
  for (const e of JSON.parse(readFileSync(join(raw, f), 'utf8'))) {
    if (seen.has(e.id)) continue; // pages shift while fetching, so the same event can appear twice
    seen.add(e.id);
    const isPR = e.type === 'PullRequestEvent';
    const r = { src: 'events', id: e.id, t: ts(e.created_at), kind: e.type, action: e.payload?.action ?? null, repo: e.repo.name };
    if (isPR) { r.pr = e.payload.number; prs.add(`${e.repo.name}#${e.payload.number}`); }
    recs.push(r);
  }
}
const tdir = join(raw, 'issue_events');
const kept = new Set(['closed', 'reopened', 'merged', 'head_ref_force_pushed']);
let tl = 0;
for (const f of readdirSync(tdir).filter((x) => x.endsWith('.json')).sort()) {
  const m = f.match(/^(.+?)_(.+)_(\d+)\.json$/); // owner_repo_number (owner has no underscore in our set)
  const repo = `${m[1]}/${m[2]}`;
  const pr = Number(m[3]);
  recs.push({ src: 'fetched', id: `${repo}#${pr}`, t: 0, kind: 'TimelineFetched', action: null, repo, pr }); // marks which PRs have a timeline
  for (const e of JSON.parse(readFileSync(join(tdir, f), 'utf8'))) {
    if (!kept.has(e.event)) continue;
    recs.push({ src: 'timeline', id: String(e.id), t: ts(e.created_at), kind: 'PRTimeline', action: e.event, repo, pr });
    tl++;
  }
}
recs.sort((a, b) => a.t - b.t || (a.src + a.id < b.src + b.id ? -1 : 1));
const body = recs.map((r) => JSON.stringify(r)).join('\n') + '\n';
writeFileSync(out, gzipSync(body, { level: 9 }));
console.log(JSON.stringify({ eventsApiUnique: seen.size, timelineKept: tl, total: recs.length, rawBytes: body.length, gzBytes: gzipSync(body, { level: 9 }).length, prsInEventsApi: prs.size }));
