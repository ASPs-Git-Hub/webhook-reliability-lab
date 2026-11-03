// Shared test helpers. Synthetic data only.
import { createHmac } from 'node:crypto';

export const SECRET = 'whsec_test_synthetic';

export function sign(rawBody, ts, secret = SECRET) {
  const v1 = createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');
  return `t=${ts},v1=${v1}`;
}

export function makeEvent(id, type, customer, created, extra = {}) {
  return JSON.stringify({ id, type, created, data: { customer, ...extra } });
}

export function newStore() {
  return { balances: new Map(), subs: new Map() };
}
