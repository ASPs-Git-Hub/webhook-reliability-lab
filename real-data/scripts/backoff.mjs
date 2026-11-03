// Part 3 of PROTOCOL.md. Run from real-data/: node scripts/backoff.mjs
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeFixedHandler, expBackoffJitter } from '../../src/fixed.js';
import { SECRET, sign } from '../../src/common.js';
import { loadFrozen, buildBase } from './lib/stream.mjs';
import { mulberry32 } from './lib/rng.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = []; const say = (s = '') => { out.push(s); console.log(s); };
say(`PROTOCOL.md sha256 ${createHash('sha256').update(readFileSync(join(root, 'PROTOCOL.md'))).digest('hex')}`);
say(`run at ${new Date().toISOString()}  node ${process.version}`);
const { events } = buildBase(loadFrozen(join(root, 'data/events-frozen.jsonl.gz')));
const bySec = new Map();
for (const e of events) bySec.set(e.created, [...(bySec.get(e.created) ?? []), e]);
const [sec, burst] = [...bySec.entries()].sort((a, b) => b[1].length - a[1].length || a[0] - b[0])[0];
say(`busiest real second: unix ${sec} with N=${burst.length} events`);

class AlwaysFails extends Set { delete() { return false; } }
const BASE = 100, CAP = 5000, ATTEMPTS = 5;
const configs = {
  'a default (zero)': () => () => 0,
  'b exponential, no jitter': () => (attempt) => Math.min(CAP, BASE * 2 ** attempt),
  'c expBackoffJitter (seeded)': () => expBackoffJitter(BASE, CAP, mulberry32(20261103 + 11)),
};
for (const [name, mkBackoff] of Object.entries(configs)) {
  const bo = mkBackoff();
  const sleeps = new Map(); // id -> [delays]
  let cur = null;
  const store = { balances: new Map(), subs: new Map() };
  const h = makeFixedHandler(store, {
    secret: SECRET, now: () => sec, maxAttempts: ATTEMPTS, failOnce: new AlwaysFails(burst.map((e) => e.id)),
    backoffMs: (a) => { const d = bo(a); if (!sleeps.has(cur)) sleeps.set(cur, []); sleeps.get(cur).push({ attempt: a, d }); return d; },
    sleep: async () => {},
  });
  for (const e of burst) {
    cur = e.id;
    const body = JSON.stringify({ id: e.id, type: e.type, created: e.created, data: e.data });
    await h(body, sign(body, sec));
  }
  const all = [...sleeps.values()].flat();
  let inRange = true;
  for (const { attempt, d } of all) if (!(d >= 0 && d <= Math.min(CAP, BASE * 2 ** attempt))) inRange = false;
  const round1 = [...sleeps.values()].map((v) => v[0].d);
  const buckets = new Map();
  for (const d of round1) buckets.set(Math.floor(d / 50), (buckets.get(Math.floor(d / 50)) ?? 0) + 1);
  say(`${name.padEnd(30)} events=${burst.length} sleeps_per_event=${[...sleeps.values()][0].length} (expected ${ATTEMPTS - 1}) all_in_range=${inRange} distinct_round1=${new Set(round1).size} peak_same_50ms_bucket=${Math.max(...buckets.values())} dead_lettered=${h.deadLetter.length}`);
}
writeFileSync(join(root, 'evidence/backoff-run.txt'), out.join('\n') + '\n');
