// Runs every contract against the BROKEN handler and prints what actually happens, so each
// "broken fails" in the test suite is tied to a visible, intended defect and not an unrelated crash.
// Exits 1 if any contract unexpectedly holds for the broken handler.
import { sign, makeEvent, newStore } from '../src/common.js';
import { makeBrokenHandler } from '../src/broken.js';

const NOW = 1_800_000_000;
const sg = (b, ts = NOW) => [b, sign(b, ts)];
const ev = (id, type, c, created, extra) => makeEvent(id, type, c, created, extra);
const fresh = (o) => { const s = newStore(); return [s, makeBrokenHandler(s, o)]; };

const cases = [
  ['forged signature (fresh timestamp)', async () => { const [s, h] = fresh(); const r = await h(ev('1', 'invoice.paid', 'a', NOW, { amount: 100 }), `t=${NOW},v1=${'0'.repeat(64)}`); return [r.status !== 400, `status ${r.status}, balance ${s.balances.get('a')}`]; }],
  ['wrong secret', async () => { const [s, h] = fresh(); const b = ev('2', 'invoice.paid', 'a', NOW, { amount: 100 }); const r = await h(b, sign(b, NOW, 'other')); return [r.status !== 400, `status ${r.status}`]; }],
  ['tampered body', async () => { const [s, h] = fresh(); const b = ev('3', 'invoice.paid', 'a', NOW, { amount: 100 }); const r = await h(b.replace('100', '999999'), sign(b, NOW)); return [r.status !== 400, `status ${r.status}, balance ${s.balances.get('a')}`]; }],
  ['replay outside window', async () => { const [s, h] = fresh(); const b = ev('4', 'invoice.paid', 'a', NOW, { amount: 100 }); const r = await h(...sg(b, NOW - 3600)); return [r.status !== 400, `status ${r.status}`]; }],
  ['duplicate delivery', async () => { const [s, h] = fresh(); const b = ev('5', 'invoice.paid', 'a', NOW, { amount: 100 }); await h(...sg(b)); await h(...sg(b)); return [s.balances.get('a') !== 100, `balance ${s.balances.get('a')} (expected 100)`]; }],
  ['concurrent duplicates', async () => { const [s, h] = fresh(); const b = ev('6', 'invoice.paid', 'a', NOW, { amount: 100 }); await Promise.all([h(...sg(b)), h(...sg(b)), h(...sg(b))]); return [s.balances.get('a') !== 100, `balance ${s.balances.get('a')} (expected 100)`]; }],
  ['out-of-order overwrite', async () => { const [s, h] = fresh(); await h(...sg(ev('8', 'subscription.canceled', 'b', NOW + 10))); await h(...sg(ev('7', 'subscription.activated', 'b', NOW))); return [s.subs.get('b').status !== 'canceled', `final status ${s.subs.get('b').status} (expected canceled)`]; }],
  ['same-second arrival order', async () => { const run = async (o) => { const [s, h] = fresh(); for (const [id, t] of o) await h(...sg(ev(id, t, 'b', NOW))); return s.subs.get('b').status; }; const a = await run([['a1', 'subscription.activated'], ['a2', 'subscription.canceled']]); const b = await run([['a2', 'subscription.canceled'], ['a1', 'subscription.activated']]); return [a !== b, `order 1 -> ${a}, order 2 -> ${b}`]; }],
  ['transient failure', async () => { const [s, h] = fresh({ failOnce: new Set(['9']) }); const r = await h(...sg(ev('9', 'invoice.paid', 'c', NOW, { amount: 50 }))); return [r.status === 200 && s.balances.get('c') === undefined, `told ${r.status}, balance ${s.balances.get('c')} (event lost)`]; }],
  ['null body', async () => { const [, h] = fresh(); try { const r = await h(...sg('null')); return [r.status !== 400, `status ${r.status}`]; } catch (e) { return [true, `throws ${e.name}: ${e.message}`]; } }],
  ['event without id', async () => { const [s, h] = fresh(); const r = await h(...sg(JSON.stringify({ type: 'invoice.paid', created: NOW, data: { customer: 'c', amount: 5 } }))); return [r.status !== 400, `status ${r.status}`]; }],
  ['string amount', async () => { const [s, h] = fresh(); const r = await h(...sg(ev('10', 'invoice.paid', 'c', NOW, { amount: '100' }))); return [r.status !== 400, `status ${r.status}, balance ${JSON.stringify(s.balances.get('c'))}`]; }],
];

let unexpected = 0;
for (const [name, fn] of cases) {
  const [defect, detail] = await fn();
  if (!defect) unexpected++;
  console.log(`${defect ? 'DEFECT REPRODUCED' : 'UNEXPECTED PASS  '}: ${name} -> ${detail}`);
}
console.log(`${cases.length - unexpected} of ${cases.length} contracts fail on the broken handler as intended`);
process.exit(unexpected ? 1 : 0);
