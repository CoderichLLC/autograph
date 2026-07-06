/* eslint-disable class-methods-use-this */
// Zero-latency in-memory driver: isolates FRAMEWORK CPU from I/O. Implements the driver
// contract floor (incl. Part 2's returning mutations: updateOne → post-image, deleteOne →
// pre-image). Equality-only where matching — sufficient for the bench scenarios.
const matches = (row, where = {}) => Object.entries(where).every(([k, v]) => {
  if (Array.isArray(v)) return v.some(x => `${row[k]}` === `${x}`);
  if (v !== null && typeof v === 'object') return true; // operator objects unused by bench
  return `${row[k]}` === `${v}`;
});

module.exports = class InstantDriver {
  constructor() { this.tables = new Map(); }

  table(model) {
    if (!this.tables.has(model)) this.tables.set(model, new Map());
    return this.tables.get(model);
  }

  prepare(query) { return query; }

  execute(plan) {
    const rows = [...this.table(plan.model).values()];
    switch (plan.op) {
      case 'findOne': return Promise.resolve(rows.find(r => matches(r, plan.where)) ?? null);
      case 'findMany': return Promise.resolve(rows.filter(r => matches(r, plan.where)));
      case 'count': return Promise.resolve(rows.filter(r => matches(r, plan.where)).length);
      case 'createOne': {
        const row = { ...plan.input };
        this.table(plan.model).set(`${row._id}`, row);
        return Promise.resolve(row);
      }
      case 'updateOne': {
        const row = rows.find(r => matches(r, plan.where));
        if (!row) return Promise.resolve(null);
        Object.assign(row, plan.input);
        return Promise.resolve({ ...row });
      }
      case 'deleteOne': {
        const row = rows.find(r => matches(r, plan.where));
        if (row) this.table(plan.model).delete(`${row._id}`);
        return Promise.resolve(row ?? null);
      }
      case 'deleteMany': {
        const targets = rows.filter(r => matches(r, plan.where));
        targets.forEach(r => this.table(plan.model).delete(`${r._id}`));
        return Promise.resolve({ deletedCount: targets.length });
      }
      default: return Promise.resolve(null);
    }
  }

  disconnect() {}
};

// Same driver with a fixed per-call delay: makes ROUND-TRIP COUNTS visible as wall-clock.
module.exports.withLatency = (driver, ms = 1) => new Proxy(driver, {
  get(target, prop) {
    if (prop === 'execute') {
      return plan => new Promise((resolve) => { setTimeout(resolve, ms); }).then(() => target.execute(plan));
    }
    const value = Reflect.get(target, prop, target);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});
