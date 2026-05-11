const QueryResolver = require('./QueryResolver');

module.exports = class QueryResolverTransaction extends QueryResolver {
  #config;

  constructor(config) {
    super(config);
    this.#config = config;
  }

  // Snapshot #query state SYNCHRONOUSLY before awaiting the transaction. QueryBuilder mutates
  // its private #query in place on each terminal command (count/many/save/etc), so a deferred
  // super.terminate() would otherwise see whatever the LAST terminal command set — e.g. the
  // connection wrapper calls count(), edges(), pageInfo() synchronously, and without this
  // snapshot the count terminate would route as `findMany` and return [] instead of a number.
  terminate() {
    const q = this.#config.query;
    const snapshot = { ...q, args: { ...q.args }, options: { ...q.options }, meta: { ...q.meta }, flags: { ...q.flags } };
    return this.#config.transaction.then((transaction) => {
      Object.assign(snapshot.options, transaction); // attach session/commit/rollback
      return super.terminate(snapshot);
    });
  }
};
