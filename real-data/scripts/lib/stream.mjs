// Builds the base delivery stream and the ground truth from the frozen real-event file. Pure data in, plain objects out.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

export function loadFrozen(path) {
  return gunzipSync(readFileSync(path)).toString('utf8').trim().split('\n').map((l) => JSON.parse(l));
}

const OPEN_ACTIONS = new Set(['opened', 'reopened']);
const CLOSE_ACTIONS = new Set(['closed', 'merged']);

// Returns { events, truth, stats }.
// events: lab-shaped events {id, type, created, data:{customer, amount?}, meta}. meta is only for the harness.
// truth: Map customer -> { final: 'open'|'closed', scorable: bool, nStateEvents }
export function buildBase(recs) {
  const fetched = new Set(recs.filter((r) => r.src === 'fetched').map((r) => `${r.repo}#${r.pr}`));
  const events = [];
  const stateByPr = new Map();
  const addState = (r, idPrefix) => {
    const key = `${r.repo}#${r.pr}`;
    const opens = OPEN_ACTIONS.has(r.action);
    const ev = {
      id: `${idPrefix}-${r.id}`, type: opens ? 'subscription.activated' : 'subscription.canceled', created: r.t,
      data: { customer: `pr-${key}` }, meta: { state: opens ? 'open' : 'closed', key, action: r.action },
    };
    events.push(ev);
    if (!stateByPr.has(key)) stateByPr.set(key, []);
    stateByPr.get(key).push(ev);
  };
  for (const r of recs) {
    if (r.src === 'fetched') continue;
    const key = `${r.repo}#${r.pr}`;
    if (r.src === 'events') {
      if (r.kind === 'PullRequestEvent' && fetched.has(key)) {
        if (r.action === 'opened') { addState(r, 'ev'); continue; }
        if (r.action === 'closed' || r.action === 'merged' || r.action === 'reopened') continue; // superseded by the timeline copy
      }
      events.push({ id: `ev-${r.id}`, type: 'invoice.paid', created: r.t, data: { customer: `c-ev-${r.id}`, amount: 1 }, meta: { counter: true } });
    } else if (r.src === 'timeline') {
      if (r.action === 'head_ref_force_pushed') {
        events.push({ id: `ie-${r.id}`, type: 'invoice.paid', created: r.t, data: { customer: `c-ie-${r.id}`, amount: 1 }, meta: { counter: true } });
      } else addState(r, 'ie');
    }
  }
  const truth = new Map();
  let ambiguous = 0;
  for (const [key, list] of stateByPr) {
    const sorted = [...list].sort((a, b) => a.created - b.created);
    const last = sorted[sorted.length - 1];
    // Ambiguous when the last second holds events that lead to different states: real order is unknowable at one-second resolution.
    const sameSecond = sorted.filter((e) => e.created === last.created);
    const amb = new Set(sameSecond.map((e) => e.meta.state)).size > 1;
    // Also ambiguous when ANY second holds opposing states (the lab's tie-break could matter mid-sequence).
    const bySec = new Map();
    for (const e of sorted) { if (!bySec.has(e.created)) bySec.set(e.created, new Set()); bySec.get(e.created).add(e.meta.state); }
    const anyAmb = [...bySec.values()].some((s) => s.size > 1);
    if (anyAmb) ambiguous++;
    truth.set(`pr-${key}`, { final: last.meta.state, scorable: list.length >= 2 && !anyAmb, nState: list.length, ambiguous: anyAmb, endAmbiguous: amb });
  }
  events.sort((a, b) => a.created - b.created || (a.id < b.id ? -1 : 1));
  const counters = events.filter((e) => e.meta.counter).length;
  const stats = {
    events: events.length, counterEvents: counters, stateEvents: events.length - counters,
    prsWithState: truth.size, prsWith2plusState: [...truth.values()].filter((t) => t.nState >= 2).length,
    prsAmbiguous: ambiguous, prsScorable: [...truth.values()].filter((t) => t.scorable).length,
  };
  return { events, truth, stats };
}
