// FIXED handler (v2, after independent QA). Each guard maps to tests in test/ and to a mutation in scripts/mutate.py.
import { createHmac, timingSafeEqual } from 'node:crypto';

const TOLERANCE_S = 300;
const HEX64 = /^[0-9a-fA-F]{64}$/;

// Signature header: "t=<unix seconds>,v1=<hex hmac>[,v1=<hex hmac>...]" (several v1 values allow secret rotation).
export function verify(rawBody, header, secrets, nowS) {
  if (typeof header !== 'string' || !Number.isFinite(nowS)) return false;
  let t = null;
  const sigs = [];
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === 't') t = v;
    else if (k === 'v1') sigs.push(v);
  }
  if (t === null || !/^\d{1,12}$/.test(t)) return false; // decimal integer seconds only
  if (Math.abs(nowS - Number(t)) > TOLERANCE_S) return false; // replay window, both directions
  for (const secret of [].concat(secrets)) {
    const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest();
    for (const s of sigs) {
      if (!HEX64.test(s)) continue; // never let Buffer.from('hex') silently truncate bad input
      const given = Buffer.from(s, 'hex');
      if (given.length === expected.length && timingSafeEqual(given, expected)) return true;
    }
  }
  return false;
}

// Returns an error string, or null when the event is well formed.
export function validateEvent(ev) {
  if (ev === null || typeof ev !== 'object' || Array.isArray(ev)) return 'event must be an object';
  if (typeof ev.id !== 'string' || ev.id === '') return 'missing id';
  if (typeof ev.type !== 'string') return 'missing type';
  if (!Number.isSafeInteger(ev.created)) return 'created must be an integer';
  if (ev.data === null || typeof ev.data !== 'object' || typeof ev.data.customer !== 'string' || ev.data.customer === '') {
    return 'missing data.customer';
  }
  if (ev.type === 'invoice.paid' && !(Number.isSafeInteger(ev.data.amount) && ev.data.amount > 0)) {
    return 'amount must be a positive integer (minor units)';
  }
  return null;
}

// Full-jitter exponential backoff (AWS Architecture Blog, 'Exponential Backoff and Jitter'): pass as backoffMs.
export const expBackoffJitter = (baseMs = 100, capMs = 5000, rand = Math.random) => (attempt) =>
  Math.floor(rand() * Math.min(capMs, baseMs * 2 ** attempt));

export function makeFixedHandler(store, {
  secret, // a string, or an array of strings during secret rotation
  now = () => Math.floor(Date.now() / 1000),
  failOnce = new Set(),
  maxAttempts = 3,
  backoffMs = () => 0, // production: exponential with jitter, e.g. (a) => Math.random() * 200 * 2 ** a
  sleep = async () => {},
  log = () => {}, // security log hook: called with {event, reason, id?} for every rejected or failed delivery
}) {
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    throw new RangeError('maxAttempts must be an integer from 1 to 10');
  }
  const done = new Set(); // processed event ids (production: a unique index written in the same transaction as the business update)
  const inflight = new Map(); // id -> promise, collapses concurrent duplicates
  const deadLetter = []; // one record per event id (production: a durable queue with retention)
  const deadIds = new Set();

  async function apply(ev) {
    const c = ev.data.customer;
    if (failOnce.has(ev.id)) {
      failOnce.delete(ev.id);
      throw new Error('transient db error');
    }
    if (ev.type === 'invoice.paid') {
      store.balances.set(c, (store.balances.get(c) ?? 0) + ev.data.amount);
    } else if (ev.type === 'subscription.activated' || ev.type === 'subscription.canceled') {
      const cur = store.subs.get(c);
      // Order by (created, id): deterministic whatever the arrival order. Within one second the
      // provider's own sequence number would be authoritative; event id is the stand-in here.
      if (cur && (cur.at > ev.created || (cur.at === ev.created && cur.id >= ev.id))) return;
      store.subs.set(c, { status: ev.type === 'subscription.activated' ? 'active' : 'canceled', at: ev.created, id: ev.id });
    }
  }

  async function process(ev) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await apply(ev);
        done.add(ev.id);
        return { status: 200 };
      } catch (err) {
        if (attempt === maxAttempts) {
          if (!deadIds.has(ev.id)) {
            deadIds.add(ev.id);
            deadLetter.push({ event: ev, error: String(err.message) });
            log({ event: 'dead-lettered', reason: String(err.message), id: ev.id });
          }
          return { status: 500, deadLettered: true }; // non-2xx so the provider also retries
        }
        await sleep(backoffMs(attempt));
      }
    }
  }

  async function handle(rawBody, sigHeader) {
    if (!verify(rawBody, sigHeader, secret, now())) { log({ event: 'rejected', reason: 'bad signature' }); return { status: 400, error: 'bad signature' }; }
    let ev;
    try { ev = JSON.parse(rawBody); } catch { log({ event: 'rejected', reason: 'bad json' }); return { status: 400, error: 'bad json' }; }
    const bad = validateEvent(ev);
    if (bad) { log({ event: 'rejected', reason: bad }); return { status: 400, error: bad }; }
    if (done.has(ev.id)) return { status: 200, duplicate: true };
    if (inflight.has(ev.id)) {
      const r = await inflight.get(ev.id); // share the first attempt's outcome, success or failure
      return r.status === 200 ? { ...r, duplicate: true } : r;
    }
    const p = process(ev);
    inflight.set(ev.id, p);
    try { return await p; } finally { inflight.delete(ev.id); }
  }

  handle.deadLetter = deadLetter;
  return handle;
}
