/**
 * Wraps a driver client so the TestSuite can count AG-VISIBLE driver calls — execute()
 * invocations, keyed by op. Driver-internal I/O (a scan inside RedisDriver.updateOne, the
 * partial-JSONB re-read inside PostgresDriver) is deliberately invisible: the budget contract
 * counts what autograph dispatches, not what the substrate does to satisfy it.
 *
 * A Proxy (not Object.create delegation) so pass-through methods run with `this` bound to the
 * real client — drivers use #private fields, whose brand checks reject a delegating receiver.
 * The wrapper becomes THE client identity autograph sees (dataSource.client), so
 * TransactionScope's identity-keyed session map stays coherent.
 */
module.exports = (client) => {
  const calls = {
    total: 0,
    byOp: {},
    reset() { this.total = 0; this.byOp = {}; },
  };
  const ops = new WeakMap(); // plan -> op; plans are opaque — never mutate driver-visible fields

  const wrapped = new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'prepare') {
        return (query) => {
          const plan = target.prepare(query);
          if (plan !== null && typeof plan === 'object') ops.set(plan, query.op);
          return plan;
        };
      }
      if (prop === 'execute') {
        return (plan) => {
          const op = ops.get(plan) ?? 'unknown';
          calls.total += 1;
          calls.byOp[op] = (calls.byOp[op] ?? 0) + 1;
          return target.execute(plan);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  return { client: wrapped, calls };
};
