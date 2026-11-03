// BROKEN handler: the failure modes seen in real webhook integrations.
// 1 no signature check  2 no idempotency (duplicate delivery double-credits)
// 3 out-of-order events overwrite newer state  4 a transient error is lost (no retry, no dead letter)
export function makeBrokenHandler(store, { failOnce = new Set() } = {}) {
  return async function handle(rawBody /* , sigHeader, now */) {
    const ev = JSON.parse(rawBody);
    const c = ev.data.customer;
    try {
      if (failOnce.has(ev.id)) {
        failOnce.delete(ev.id);
        throw new Error('transient db error');
      }
      if (ev.type === 'invoice.paid') {
        store.balances.set(c, (store.balances.get(c) ?? 0) + ev.data.amount);
      } else if (ev.type === 'subscription.activated') {
        store.subs.set(c, { status: 'active', at: ev.created });
      } else if (ev.type === 'subscription.canceled') {
        store.subs.set(c, { status: 'canceled', at: ev.created });
      }
      return { status: 200 };
    } catch {
      return { status: 200 }; // swallowed: provider thinks it succeeded, event is gone
    }
  };
}
