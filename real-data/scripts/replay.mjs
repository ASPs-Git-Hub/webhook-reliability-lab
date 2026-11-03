// Part 2 of PROTOCOL.md. Local replay only, no listener. Run from real-data/: node scripts/replay.mjs
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeFixedHandler } from '../../src/fixed.js';
import { makeBrokenHandler } from '../../src/broken.js';
import { SECRET, sign, newStore } from '../../src/common.js';
import { loadFrozen, buildBase } from './lib/stream.mjs';
import { mulberry32 } from './lib/rng.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = [];
const say = (s = '') => { out.push(s); console.log(s); };
say(`PROTOCOL.md sha256 ${createHash('sha256').update(readFileSync(join(root, 'PROTOCOL.md'))).digest('hex')}`);
say(`frozen data sha256 ${createHash('sha256').update(readFileSync(join(root, 'data/events-frozen.jsonl.gz'))).digest('hex')}`);
say(`run at ${new Date().toISOString()}  node ${process.version}`);

const { events, truth, stats } = buildBase(loadFrozen(join(root, 'data/events-frozen.jsonl.gz')));
say(`base stream: ${JSON.stringify(stats)}`);
const bodyOf = (e) => JSON.stringify({ id: e.id, type: e.type, created: e.created, data: e.data });

// One plan = list of deliveries {ev, arrive, sendAt, kind, seq}. All random draws happen in a fixed order per event.
function plan(k, f) {
  const rand = mulberry32(20261103 + k);
  const ds = [];
  let seq = 0;
  const failOnce = new Set(), failAlways = new Set();
  for (const ev of events) {
    const dup1 = rand() < 0.30, dup2 = rand() < 0.20;
    const off1 = 1 + Math.floor(rand() * 30), off2 = 1 + Math.floor(rand() * 30);
    const reo = rand() < 0.30, reoDelay = 1 + Math.floor(rand() * 250);
    const lng = rand() < 0.10, lngDelay = 301 + Math.floor(rand() * (7200 - 301 + 1));
    const trans = rand() < 0.05, perm = rand() < 0.01;
    const rep = rand() < 0.10, repDelay = 301 + Math.floor(rand() * (7200 - 301 + 1));
    let arrive = ev.created, sendAt = ev.created;
    if (f.longDelay && lng) { arrive = ev.created + lngDelay; sendAt = arrive; }
    else if (f.reorder && reo) { arrive = ev.created + reoDelay; sendAt = ev.created; }
    ds.push({ ev, arrive, sendAt, kind: 'orig', seq: seq++ });
    if (f.dup && dup1) {
      const a = arrive + off1; ds.push({ ev, arrive: a, sendAt: a, kind: 'dup', seq: seq++ });
      if (dup2) { const b = arrive + off1 + off2; ds.push({ ev, arrive: b, sendAt: b, kind: 'dup', seq: seq++ }); }
    }
    if (f.replay && rep) ds.push({ ev, arrive: ev.created + repDelay, sendAt: ev.created, kind: 'replay', seq: seq++ });
    if (f.transient && trans) failOnce.add(ev.id);
    if (f.perm && perm) failAlways.add(ev.id);
  }
  if (f.reverse) {
    const byKey = new Map();
    for (const d of ds) if (d.ev.meta.key) { if (!byKey.has(d.ev.meta.key)) byKey.set(d.ev.meta.key, []); byKey.get(d.ev.meta.key).push(d); }
    for (const list of byKey.values()) {
      list.sort((a, b) => a.arrive - b.arrive || a.seq - b.seq);
      const slots = list.map((d) => d.arrive);
      list.forEach((d, i) => { d.arrive = slots[slots.length - 1 - i]; d.sendAt = d.arrive; });
    }
  }
  ds.sort((a, b) => a.arrive - b.arrive || a.seq - b.seq);
  return { ds, failOnce, failAlways };
}

class AlwaysFails extends Set { delete() { return false; } }
class TrackedMap extends Map {
  stale = 0;
  set(k, v) { const o = super.get(k); if (o && v.at < o.at) this.stale++; return super.set(k, v); }
}

let concurrentPairs = 0;
async function run(impl, p, burst) {
  concurrentPairs = 0;
  const store = { balances: new Map(), subs: new TrackedMap() };
  const clock = { t: 0 };
  const failOnce = new Set(p.failOnce);
  if (p.failAlways.size) for (const id of p.failAlways) failOnce.add(id);
  let fo = failOnce;
  if (p.failAlways.size) { fo = new AlwaysFails(p.failAlways); for (const id of p.failOnce) fo.add(id); }
  const handler = impl === 'fixed'
    ? makeFixedHandler(store, { secret: SECRET, now: () => clock.t, failOnce: fo })
    : makeBrokenHandler(store, { failOnce: fo });
  const status = { 200: 0, 400: 0, 500: 0 };
  const evStatus = new Map(); // event id -> set of statuses seen
  let replaysAccepted = 0, replaysSent = 0;
  const send = async (d) => {
    const body = bodyOf(d.ev);
    const r = await handler(body, sign(body, d.sendAt));
    status[r.status] = (status[r.status] ?? 0) + 1;
    if (!evStatus.has(d.ev.id)) evStatus.set(d.ev.id, new Set());
    evStatus.get(d.ev.id).add(r.status);
    if (d.kind === 'replay') { replaysSent++; if (r.status === 200) replaysAccepted++; }
  };
  if (!burst) {
    for (const d of p.ds) { clock.t = d.arrive; await send(d); }
  } else {
    let i = 0;
    while (i < p.ds.length) {
      const bucket = Math.floor(p.ds[i].arrive / 10);
      let j = i; while (j < p.ds.length && Math.floor(p.ds[j].arrive / 10) === bucket) j++;
      const group = p.ds.slice(i, j);
      clock.t = Math.max(...group.map((d) => d.arrive));
      const ids = group.map((d) => d.ev.id); concurrentPairs += ids.length - new Set(ids).size;
      await Promise.all(group.map(send));
      i = j;
    }
  }
  // metrics
  let dupExtra = 0, dropped = 0, silentLost = 0, counters = 0;
  for (const ev of events) {
    if (!ev.meta.counter) continue;
    counters++;
    const applied = store.balances.get(ev.data.customer) ?? 0;
    if (applied > 1) dupExtra += applied - 1;
    if (applied === 0) { dropped++; if (evStatus.get(ev.id)?.has(200)) silentLost++; }
  }
  let wrongAll = 0, wrongMulti = 0, multi = 0;
  for (const [cust, t] of truth) {
    const s = store.subs.get(cust)?.status;
    const got = s === 'active' ? 'open' : s === 'canceled' ? 'closed' : 'none';
    const wrong = got !== t.final;
    if (wrong) wrongAll++;
    if (t.scorable) { multi++; if (wrong) wrongMulti++; }
  }
  return {
    dup_extra: dupExtra, dropped, silent_lost: silentLost, dead_lettered: impl === 'fixed' ? handler.deadLetter.length : 'n/a',
    wrong_final_all: `${wrongAll}/${truth.size}`, wrong_final_multi: `${wrongMulti}/${multi}`, stale_overwrites: store.subs.stale,
    http200: status[200], http400: status[400], http500: status[500],
    replays_accepted: replaysSent ? `${replaysAccepted}/${replaysSent}` : '-', deliveries: p.ds.length, ...(burst ? { same_event_copies_in_same_burst: concurrentPairs } : {}),
  };
}

const SCEN = [
  ['S0 clean', 0, {}, false],
  ['S1 duplicates', 1, { dup: true }, false],
  ['S2 reorder', 2, { reorder: true }, false],
  ['S3 reverse', 3, { reverse: true }, false],
  ['S4 long delay', 4, { longDelay: true }, false],
  ['S5 burst+dups', 5, { dup: true }, true],
  ['S6 transient fail', 6, { transient: true }, false],
  ['S6p permanent fail', 6, { perm: true }, false],
  ['S7 everything', 7, { dup: true, reorder: true, longDelay: true, transient: true }, true],
  ['S8 stale replay', 8, { replay: true }, false],
];
const results = {};
for (const [name, k, f, burst] of SCEN) {
  const p = plan(k, f);
  results[name] = {};
  say(`\n== ${name}  (seed ${20261103 + k}, flags ${JSON.stringify(f)}, burst=${burst}, deliveries=${p.ds.length}, failOnce=${p.failOnce.size}, failAlways=${p.failAlways.size}) ==`);
  for (const impl of ['broken', 'fixed']) {
    const r = await run(impl, p, burst);
    results[name][impl] = r;
    say(`${impl.padEnd(6)} ${Object.entries(r).map(([a, b]) => `${a}=${b}`).join(' ')}`);
  }
}
writeFileSync(join(root, 'evidence/replay-run.txt'), out.join('\n') + '\n');
writeFileSync(join(root, 'evidence/replay-results.json'), JSON.stringify({ stats, results }, null, 1) + '\n');
