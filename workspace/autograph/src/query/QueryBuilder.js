const Query = require('./Query');
const { getGQLReturnType, mergeDeep } = require('../service/AppService');

module.exports = class QueryBuilder {
  #query;
  #config;
  #terminalCommands = ['one', 'many', 'count', 'save', 'delete', 'first', 'last', 'push', 'pull', 'splice'];

  constructor(config) {
    const { schema, query } = config;

    this.#config = config;
    const model = schema.models[query.model];

    this.#query = Object.defineProperties(query, {
      id: { writable: true, enumerable: true, value: query.id },
      args: { writable: true, enumerable: true, value: query.args || {} },
      meta: { writable: true, enumerable: true, value: query.meta || {} },
      flags: { writable: true, enumerable: true, value: query.flags || {} },
      select: { writable: true, enumerable: true, value: query.select || Object.keys(model.fields) },
      options: { writable: true, enumerable: true, value: query.options || {} },
    });

    // Aliases
    this.opts = this.options;
    this.sortBy = this.sort;
    this.remove = this.delete;
  }

  isTerminal(cmd) {
    return this.#terminalCommands.includes(cmd);
  }

  /**
   * When a termnial command is called, terminate() returns the Query object
   * We have to clone() the Query because we mutate this.#config all while the query is being built
   * However there is a "bug" when using .resolve() (below) and the QueryBuilder is re-used to resolve each thunk
   */
  terminate(queryOverride) {
    const config = queryOverride ? { ...this.#config, query: queryOverride } : this.#config;
    return new Query(config).clone();
  }

  /**
   * For use in GraphQL resolver methods to return the "correct" response
   */
  resolve(info) {
    // The caller is returning this query as the field's result, so the field's selection set
    // IS this model's selection — attach it so user-authored resolvers get selection-aware
    // eager/lazy scheduling without needing to know about .info().
    this.info(info);
    switch (getGQLReturnType(info)) {
      case 'array': return this.many();
      case 'number': return this.count();
      case 'connection': return { count: () => this.count(), edges: () => this.many(), pageInfo: () => this.many() };
      case 'scalar': default: return this.one();
    }
  }

  /**
   * Chainable methods
   */
  id(id) {
    this.#propCheck('id', 'sort', 'skip', 'limit', 'before', 'after');
    this.#query.id = id;
    this.#query.where = mergeDeep(this.#query.where || {}, { id });
    this.#query.args.id = id;
    return this;
  }

  args(args = {}) {
    Object.entries(args).forEach(([key, value]) => {
      // `first`/`last` are BOTH connection arguments and TERMINAL commands — `first(n)` ends in
      // `return this.many()`. Invoking one from here dispatched the query on the spot, so every
      // `findX(first: n)` executed TWICE: once mid-argument-application, discarded, and again when
      // the caller's own terminal ran. Measured, not inferred — `.match(M).args({ first: 2 })` alone
      // produced one `Resolver#resolve`. The wasted read is the small half; the real cost is that
      // `preQuery`/`postQuery` fired an extra time for a query nobody asked for. Apply the paging
      // state and let the caller's terminal do the dispatching.
      if (key === 'first') this.#applyFirst(value);
      else if (key === 'last') this.#applyLast(value);
      // No OTHER terminal may be invoked as an argument either. A schema extension is free to name
      // an argument `save` or `count`, and running it because the name collides with a builder
      // method is the same bug with a worse blast radius. Preserve it as an arg instead.
      else if (this.isTerminal(key)) this.#query.args[key] = value;
      // Known builder methods drive the builder. Unknown keys (e.g., schema extensions like
      // `findNetworkPlace(search: String)`) are preserved on `args` so hooks can see them via
      // `event.query.args.<key>`. Without this, custom GraphQL args are silently dropped.
      else if (typeof this[key] === 'function') this[key](value);
      else this.#query.args[key] = value;
    });
    return this;
  }

  info(info) {
    // Store info on the query so the resolve path can build a selection tree once and
    // drive selection-aware eager/lazy decisions in docTransform. See AppService.buildSelectionTree.
    this.#query.info = info;
    return this;
  }

  where(clause) {
    this.#propCheck('where', false); // Allow redefine of "where" because we merge it
    // null/undefined = "no constraint", same as omitting the call. GraphQL's nullable `where:`
    // argument delivers exactly this shape; it must not reach mergeDeep (TypeError) or clobber
    // an already-merged clause.
    if (clause == null) return this;
    // Legacy OR form: an ARRAY of where clauses. Normalize to its canonical vocabulary spelling
    // ($or) here at the builder boundary — a raw array is hostile to everything downstream:
    // mergeDeep DISCARDS previously-merged object clauses when handed an array (type-mismatch
    // overwrite), and Query#transformWhere's rest-destructure would spread the survivor into
    // index keys ('0', '1') that the field transformer silently drops (match-all).
    if (Array.isArray(clause)) clause = { $or: clause };
    const $clause = mergeDeep(this.#query.where || {}, clause);
    this.#query.where = $clause;
    this.#query.args.where = $clause;
    return this;
  }

  select(...select) {
    select = select.flat();
    this.#query.select = select;
    this.#query.args.select = select;
    return this;
  }

  skip(skip) {
    this.#propCheck('skip', 'id');
    this.isClassicPaging = true;
    this.#query.skip = skip;
    this.#query.args.skip = skip;
    return this;
  }

  limit(limit) {
    this.#propCheck('limit', 'id');
    this.isClassicPaging = true;
    this.#query.limit = limit;
    this.#query.args.limit = limit;
    return this;
  }

  before(before) {
    this.#propCheck('before', 'id');
    this.#query.isCursorPaging = true;
    this.#query.before = before;
    this.#query.args.before = before;
    return this;
  }

  after(after) {
    this.#propCheck('after', 'id');
    this.#query.isCursorPaging = true;
    this.#query.after = after;
    this.#query.args.after = after;
    return this;
  }

  sort(sort) {
    this.#propCheck('sort', 'id');
    this.#query.sort = sort;
    this.#query.args.sort = sort;
    return this;
  }

  meta(meta) {
    this.#query.meta = meta;
    this.#query.args.meta = meta;
    return this;
  }

  options(options) {
    Object.assign(this.#query.options, options);
    return this;
  }

  flags(flags) {
    Object.assign(this.#query.flags, flags);
    const { native } = this.#query.flags;
    const matches = key => native === true || (Array.isArray(native) && native.includes(key));
    this.#query.isWhereNative = matches('where');
    this.#query.isSaveNative = matches('save');
    this.#query.isSortNative = matches('sort');
    return this;
  }

  /**
   * Core terminal commands
   */
  one(flags) {
    return this.flags(flags).terminate(Object.assign(this.#query, { op: 'findOne', crud: 'read', key: `get${this.#query.model}` }));
  }

  many(flags) {
    return this.flags(flags).terminate(Object.assign(this.#query, { op: 'findMany', crud: 'read', key: `find${this.#query.model}` }));
  }

  count() {
    return this.terminate(Object.assign(this.#query, { op: 'count', crud: 'read', key: `count${this.#query.model}` }));
  }

  save(...args) {
    const { id, where } = this.#query;
    const crud = (id || where ? (args[1] ? 'upsert' : 'update') : 'create'); // eslint-disable-line
    return this.#mutation(crud, ...args);
  }

  delete(...args) {
    const { id, where } = this.#query;
    if (!id && !where) throw new Error('Delete requires id() or where()');
    return this.#mutation('delete', ...args);
  }

  /**
   * Proxy terminial commands
   */
  // The paging STATE, separated from the terminal that dispatches it — `args()` needs the first
  // half without the second. See the note there.
  #applyFirst(first) {
    this.#query.isCursorPaging = true;
    this.#query.first = first + 2; // Adding 2 for pagination meta info (hasNext hasPrev)
    this.#query.args.first = first;
  }

  #applyLast(last) {
    this.#query.isCursorPaging = true;
    this.#query.last = last + 2; // Adding 2 for pagination meta info (hasNext hasPrev)
    this.#query.args.last = last;
  }

  first(first) {
    this.#applyFirst(first);
    return this.many();
  }

  last(last) {
    this.#applyLast(last);
    return this.many();
  }

  /**
   * Array terminal commands
   */
  push(path, ...values) {
    values = values.flat();
    return this.#mutation('push', { [path]: values });
  }

  pull(path, ...values) {
    values = values.flat();
    return this.#mutation('pull', { [path]: values });
  }

  splice(path, ...values) {
    values = values.flat();
    return this.#mutation('splice', { [path]: values });
  }

  /**
   */
  #mutation(crud, ...args) {
    args = args.flat();
    const { id, limit } = this.#query;
    const suffix = id || limit === 1 || (crud === 'create' && args.length < 2) ? 'One' : 'Many';
    const op = `${crud}${suffix}`;
    const key = `${crud}${this.#query.model}`;
    const $crud = ['push', 'pull', 'splice'].includes(crud) ? 'update' : crud;
    let input;

    if (['create', 'update'].includes($crud)) {
      input = op === 'createMany' ? args : args[0];
      if (input === undefined) input = {};
      this.#query.args.input = input;
    }

    return this.terminate(Object.assign(this.#query, { op, key, crud: $crud, input, isMutation: true }));
  }

  #propCheck(prop, ...checks) {
    if (checks[checks.length - 1] !== false && this.#query[prop]) throw new Error(`Cannot redefine "${prop}"`);
    if (['skip', 'limit'].includes(prop) && this.#query.isCursorPaging) throw new Error(`Cannot use "${prop}" while using Cursor-Style Pagination`);
    if (['first', 'last', 'before', 'after'].includes(prop) && this.isClassicPaging) throw new Error(`Cannot use "${prop}" while using Classic-Style Pagination`);
    checks.forEach((check) => { if (this.#query[check]) throw new Error(`Cannot use "${prop}" while using "${check}"`); });
  }
};
