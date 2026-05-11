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
    this.#propCheck('id', 'native', 'sort', 'skip', 'limit', 'before', 'after');
    this.#query.id = id;
    this.#query.where = mergeDeep(this.#query.where || {}, { id });
    this.#query.args.id = id;
    return this;
  }

  args(args = {}) {
    Object.entries(args).forEach(([key, value]) => { if (this[key]) this[key](value); }); // Call method only if exists
    return this;
  }

  info(info) {
    // this.select(getGQLSelectFields(this.#query.model, info));
    return this;
  }

  native(clause) {
    this.#propCheck('native', 'id', 'where');
    this.#query.isNative = true;
    this.#query.native = clause;
    this.#query.where = clause;
    this.#query.args.native = clause;
    return this;
  }

  where(clause) {
    this.#propCheck('where', 'native', false); // Allow redefine of "where" because we merge it
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
  first(first) {
    this.#query.isCursorPaging = true;
    this.#query.first = first + 2; // Adding 2 for pagination meta info (hasNext hasPrev)
    this.#query.args.first = first;
    return this.many();
  }

  last(last) {
    this.#query.isCursorPaging = true;
    this.#query.last = last + 2; // Adding 2 for pagination meta info (hasNext hasPrev)
    this.#query.args.last = last;
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
      if (id !== undefined) input.id = id;
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
