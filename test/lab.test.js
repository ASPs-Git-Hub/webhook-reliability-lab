import test from 'node:test';
import assert from 'node:assert/strict';
import { sign, makeEvent, newStore, SECRET } from '../src/common.js';
import { makeBrokenHandler } from '../src/broken.js';
import { makeFixedHandler, expBackoffJitter } from '../src/fixed.js';

const NOW = 1_800_000_000;
const impls = {
  broken: (store, o = {}) => makeBrokenHandler(store, o),
  fixed: (store, o = {}) => makeFixedHandler(store, { secret: SECRET, now: () => NOW, ...o }),
};
const signed = (body, ts = NOW) => [body, sign(body, ts)];
const ev = (id, type, cust, created, extra) => makeEvent(id, type, cust, created, extra);

// Contract tests run against both handlers. The broken handler must FAIL each contract with an
// AssertionError or a TypeError (the intended defect), never an unrelated error. scripts/broken-raw.js
// prints the exact defect for each contract.
for (const [name, mk] of Object.entries(impls)) {
  const shouldPass = name === 'fixed';
  const t = (title, fn) => test(`${name}: ${title}`, async () => {
    if (shouldPass) return fn();
    await assert.rejects(fn, (e) => e instanceof assert.AssertionError || e instanceof TypeError,
      `expected ${name} to FAIL this contract with the intended defect`);
  });

  t('rejects forged signature (fresh timestamp, well-formed but wrong MAC)', async () => {
    const store = newStore(); const h = mk(store);
    const r = await h(ev('c1', 'invoice.paid', 'a', NOW, { amount: 100 }), `t=${NOW},v1=${'0'.repeat(64)}`);
    assert.equal(r.status, 400);
    assert.equal(store.balances.get('a'), undefined);
  });

  t('rejects a signature made with the wrong secret', async () => {
    const store = newStore(); const h = mk(store);
    const body = ev('c2', 'invoice.paid', 'a', NOW, { amount: 100 });
    const r = await h(body, sign(body, NOW, 'whsec_other'));
    assert.equal(r.status, 400);
  });

  t('rejects a tampered body', async () => {
    const store = newStore(); const h = mk(store);
    const body = ev('c3', 'invoice.paid', 'a', NOW, { amount: 100 });
    const r = await h(body.replace('100', '999999'), sign(body, NOW));
    assert.equal(r.status, 400);
    assert.equal(store.balances.get('a'), undefined);
  });

  t('rejects replay outside tolerance window', async () => {
    const store = newStore(); const h = mk(store);
    const body = ev('c4', 'invoice.paid', 'a', NOW, { amount: 100 });
    assert.equal((await h(...signed(body, NOW - 3600))).status, 400);
  });

  t('duplicate delivery credits once', async () => {
    const store = newStore(); const h = mk(store);
    const body = ev('c5', 'invoice.paid', 'a', NOW, { amount: 100 });
    await h(...signed(body)); await h(...signed(body));
    assert.equal(store.balances.get('a'), 100);
  });

  t('concurrent duplicates credit once', async () => {
    const store = newStore(); const h = mk(store);
    const body = ev('c6', 'invoice.paid', 'a', NOW, { amount: 100 });
    await Promise.all([h(...signed(body)), h(...signed(body)), h(...signed(body))]);
    assert.equal(store.balances.get('a'), 100);
  });

  t('out-of-order event does not overwrite newer state', async () => {
    const store = newStore(); const h = mk(store);
    await h(...signed(ev('c8', 'subscription.canceled', 'b', NOW + 10)));
    await h(...signed(ev('c7', 'subscription.activated', 'b', NOW))); // arrives late
    assert.equal(store.subs.get('b').status, 'canceled');
  });

  t('same-second events end in the same state whatever the arrival order', async () => {
    const run = async (order) => {
      const store = newStore(); const h = mk(store);
      for (const [id, type] of order) await h(...signed(ev(id, type, 'b', NOW)));
      return store.subs.get('b').status;
    };
    const a = await run([['a1', 'subscription.activated'], ['a2', 'subscription.canceled']]);
    const b = await run([['a2', 'subscription.canceled'], ['a1', 'subscription.activated']]);
    assert.equal(a, b);
  });

  t('transient failure is retried, not lost', async () => {
    const store = newStore(); const h = mk(store, { failOnce: new Set(['c9']) });
    const r = await h(...signed(ev('c9', 'invoice.paid', 'c', NOW, { amount: 50 })));
    assert.equal(r.status, 200);
    assert.equal(store.balances.get('c'), 50);
  });

  t('a null body is rejected with 400, not a crash', async () => {
    const store = newStore(); const h = mk(store);
    const r = await h(...signed('null'));
    assert.equal(r.status, 400);
  });

  t('an event without an id is rejected, not merged with other id-less events', async () => {
    const store = newStore(); const h = mk(store);
    const noId = (amount) => JSON.stringify({ type: 'invoice.paid', created: NOW, data: { customer: 'c', amount } });
    const r = await h(...signed(noId(5)));
    assert.equal(r.status, 400);
  });

  t('a string amount is rejected, never concatenated', async () => {
    const store = newStore(); const h = mk(store);
    const r = await h(...signed(ev('c10', 'invoice.paid', 'c', NOW, { amount: '100' })));
    assert.equal(r.status, 400);
    assert.equal(store.balances.get('c'), undefined);
  });
}

// Fixed-handler behaviour with no broken-handler counterpart.
const fixed = (o = {}) => { const store = newStore(); return [store, impls.fixed(store, o)]; };

test('fixed: valid event is accepted (guards are not just rejecting everything)', async () => {
  const [store, h] = fixed();
  const r = await h(...signed(ev('f1', 'invoice.paid', 'e', NOW, { amount: 7 })));
  assert.equal(r.status, 200);
  assert.equal(store.balances.get('e'), 7);
});

test('fixed: persistent failure goes to the failure list once and returns 500', async () => {
  const [store, h] = fixed({ failOnce: { has: () => true, delete: () => {} } });
  const body = ev('f2', 'invoice.paid', 'd', NOW, { amount: 5 });
  const r = await h(...signed(body));
  assert.equal(r.status, 500);
  await h(...signed(body)); // provider retries the same event
  assert.equal(h.deadLetter.length, 1);
  assert.equal(store.balances.get('d'), undefined);
});

test('fixed: concurrent duplicates of a permanently failing event are all told 500', async () => {
  const [, h] = fixed({ failOnce: { has: () => true, delete: () => {} } });
  const body = ev('f3', 'invoice.paid', 'd', NOW, { amount: 5 });
  const rs = await Promise.all([h(...signed(body)), h(...signed(body))]);
  assert.deepEqual(rs.map((r) => r.status), [500, 500]);
});

test('fixed: signature header edge cases', async () => {
  const [, h] = fixed();
  const body = ev('f4', 'invoice.paid', 'e', NOW, { amount: 1 });
  const good = sign(body, NOW);
  assert.equal((await h(body, good + 'zz')).status, 400, 'trailing garbage');
  assert.equal((await h(body, undefined)).status, 400, 'missing header');
  assert.equal((await h(body, 42)).status, 400, 'non-string header');
  assert.equal((await h(body, `t=abc,v1=${'0'.repeat(64)}`)).status, 400, 'non-numeric timestamp');
  // Correctly signed but malformed timestamps: only the format check can reject these.
  for (const badTs of ['abc', '1800000000.5', '0x6B49D200', ' ', '']) {
    assert.equal((await h(body, sign(body, badTs))).status, 400, `signed malformed timestamp ${JSON.stringify(badTs)}`);
  }
  assert.equal((await h(body, good.replace('v1=', 'v1=00'))).status, 400, 'wrong length');
});

test('fixed: secret rotation accepts any listed v1 and any listed secret', async () => {
  const body = ev('f5', 'invoice.paid', 'e', NOW, { amount: 1 });
  const oldSig = sign(body, NOW, 'whsec_old').split('v1=')[1];
  const newSig = sign(body, NOW).split('v1=')[1];
  const [, h1] = fixed();
  assert.equal((await h1(body, `t=${NOW},v1=${'1'.repeat(64)},v1=${newSig}`)).status, 200, 'second v1 is valid');
  const [, h2] = fixed({ secret: [SECRET, 'whsec_old'] });
  assert.equal((await h2(body, `t=${NOW},v1=${oldSig}`)).status, 200, 'signed with the old secret');
});

test('fixed: tolerance boundary is exactly 300 seconds in both directions', async () => {
  const [, h] = fixed();
  const at = async (id, ts) => (await h(...signed(ev(id, 'invoice.paid', 'e', NOW, { amount: 1 }), ts))).status;
  assert.equal(await at('g1', NOW - 300), 200);
  assert.equal(await at('g2', NOW - 301), 400);
  assert.equal(await at('g3', NOW + 300), 200);
  assert.equal(await at('g4', NOW + 301), 400, 'future timestamps are rejected too');
});

test('fixed: a broken clock fails closed', async () => {
  const [, h] = fixed({ now: () => NaN });
  assert.equal((await h(...signed(ev('h1', 'invoice.paid', 'e', NOW, { amount: 1 })))).status, 400);
});

test('fixed: maxAttempts is validated', () => {
  for (const bad of [0, -1, 1.5, 11, '3', NaN]) {
    assert.throws(() => impls.fixed(newStore(), { maxAttempts: bad }), RangeError, String(bad));
  }
});

test('fixed: backoff hook is called between attempts with increasing attempt numbers', async () => {
  const waits = [];
  const [, h] = fixed({ failOnce: { has: () => true, delete: () => {} }, backoffMs: (a) => a * 10, sleep: async (ms) => waits.push(ms) });
  await h(...signed(ev('i1', 'invoice.paid', 'e', NOW, { amount: 1 })));
  assert.deepEqual(waits, [10, 20]);
});

test('fixed: security log hook records rejected and dead-lettered deliveries', async () => {
  const events = [];
  const [, h] = fixed({ log: (e) => events.push(e), failOnce: { has: (id) => id === 'l3', delete: () => {} } });
  await h(ev('l1', 'invoice.paid', 'e', NOW, { amount: 1 }), `t=${NOW},v1=${'0'.repeat(64)}`);
  await h(...signed('not json'));
  await h(...signed(ev('l2', 'invoice.paid', 'e', NOW, { amount: -5 })));
  await h(...signed(ev('l3', 'invoice.paid', 'e', NOW, { amount: 1 })));
  assert.deepEqual(events.map((e) => e.reason), ['bad signature', 'bad json', 'amount must be a positive integer (minor units)', 'transient db error']);
  assert.equal(events.at(-1).event, 'dead-lettered');
});

test('fixed: full-jitter backoff stays within the cap and grows its ceiling', () => {
  const f = expBackoffJitter(100, 1000, () => 0.999);
  assert.ok(f(1) <= 200 && f(2) <= 400 && f(3) <= 800 && f(10) <= 1000);
  assert.equal(expBackoffJitter(100, 1000, () => 0)(5), 0);
});
