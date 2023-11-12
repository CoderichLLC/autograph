const { graphql } = require('graphql');
const Boom = require('@hapi/boom');
const Util = require('@coderich/util');
const Emitter = require('./Emitter');
const Loader = require('./Loader');
const DataLoader = require('./DataLoader');
const Transaction = require('./Transaction');
const QueryResolver = require('../query/QueryResolver');

const loaders = {};

module.exports = class Resolver {
  #schema;
  #xschema;
  #context;
  #dataLoaders;
  #sessions = []; // Holds nested 2D array of transactions

  constructor({ schema, xschema, context }) {
    this.#schema = schema.parse?.() || schema;
    this.#xschema = xschema;
    this.#context = context;
    this.#dataLoaders = this.#createDataLoaders();
    this.driver = this.raw; // Alias
    this.model = this.match; // Alias
    Util.set(this.#context, `${this.#schema.namespace}.resolver`, this);
  }

  getContext() {
    return this.#context;
  }

  clear(model) {
    this.#dataLoaders[model].clearAll();
    return this;
  }

  clearAll() {
    Object.values(this.#dataLoaders).forEach(loader => loader.clearAll());
    return this;
  }

  clone() {
    return new Resolver({
      schema: this.#schema,
      context: this.#context,
    });
  }

  raw(model) {
    model = this.toModel(model);
    return model?.source?.client?.driver(model.key);
  }

  graphql(args) {
    args.schema ??= this.#xschema;
    args.contextValue ??= this.#context;
    return graphql(args);
    // const { schema } = this;
    // const variableValues = JSON.parse(JSON.stringify(variables));
    // return graphql({ schema, source, variableValues, contextValue });
  }

  /**
   * Create and execute a query for a provided model.
   *
   * @param {string|object} model - The name (string) or model (object) you wish to query
   * @returns {QueryResolver|QueryResolverTransaction} - An API to build and execute a query
   */
  match(model) {
    return this.#sessions.slice(-1).pop()?.slice(-1).pop()?.match(model) ?? new QueryResolver({
      resolver: this,
      schema: this.#schema,
      context: this.#context,
      query: { model: `${model}` },
    });
  }

  loader(name) {
    const context = this.#context;

    return new Proxy(loaders[name], {
      get(loader, fn, proxy) {
        if (fn === 'load') return args => loader.load(args, context);
        return Reflect.get(loader, fn, proxy);
      },
    });
  }

  /**
   * Start a new transaction.
   *
   * @param {boolean} isolated - Create the transaction in isolation (new resolver)
   * @param {Resolver} parent - The parent resolver that created this transaction
   * @returns {Resolver} - A Resolver instance to construct queries in a transaction
   */
  transaction(isolated = true, parent = this) {
    if (isolated) return this.clone().transaction(false, parent);

    const currSession = this.#sessions.slice(-1).pop();
    const currTransaction = currSession?.slice(-1).pop();
    const realTransaction = new Transaction({ resolver: this, schema: this.#schema, context: this.#context });
    const thunks = currTransaction ? currSession.thunks : []; // If in a transaction, piggy back off session

    // If we're already in a transaction; add the "real" transaction to the existing session
    // We do this because a "session" holds a group of transactions all bound to the same resolver
    // Therefore this transaction should resolve when THAT resolver is committed or rolled back
    if (currTransaction) currSession.push(realTransaction);

    // In the case where we are currently in a transaction we need to create a hybrid transaction
    // This transaction is part "real" transaction and part "current" transaction...
    // This transaction ultimately calls currSession.pop() to remove itself (all transactions do)
    const hybridTransaction = {
      match: (...args) => currTransaction?.match(...args), // Bound to current transaction
      commit: () => Promise.resolve(currSession.pop()), // DO NOT COMMIT! It's fate to commit is in "currSession"!
      rollback: () => realTransaction.rollback().then(() => currSession.pop()), // REALLY, we need to rollback()
    };

    // In ALL cases we MUST create a new session with either the real or hybrid transaction!
    // It is THIS transaction API that is used when resolver.match() is called
    // Additional attributes are defined for use in order to clear data loader cache during transactions
    this.#sessions.push(Object.defineProperties([currTransaction ? hybridTransaction : realTransaction], {
      parent: { value: parent }, // The parent resolver
      thunks: { value: thunks }, // Cleanup functions to run after session is completed (references parent)
    }));

    return this;
  }

  /**
   * Auto run (commit or rollback) the current transaction based on the outcome of a provided promise.
   *
   * @param {Promise} promise - A promise to resolve that determines the fate of the current transaction
   * @returns {*} - The promise resolution
   */
  run(promise) {
    return promise.then((results) => {
      return this.commit().then(() => results);
    }).catch((e) => {
      return this.rollback().then(() => Promise.reject(e));
    });
  }

  /**
   * Commit the current transaction.
   */
  commit() {
    let op = 'commit';
    const errors = [];
    const session = this.#sessions.pop()?.reverse();

    // All transactions bound to this resolver are to be committed
    return Util.promiseChain(session.map(transaction => () => {
      return transaction[op]().catch((e) => {
        op = 'rollback';
        errors.push(e);
        return transaction[op]().catch(ee => errors.push(ee));
      });
    })).then(() => {
      return errors.length ? Promise.reject(errors) : Promise.all(session.thunks.map(thunk => thunk()));
    });
  }

  /**
   * Rollback the current transaction
   */
  rollback() {
    const errors = [];
    const session = this.#sessions.pop()?.reverse();

    // All transactions bound to this resolver are to be rolled back
    return Util.promiseChain(session.map(transaction => () => {
      transaction.rollback().catch(e => errors.push(e));
    })).then(() => {
      return errors.length ? Promise.reject(errors) : Promise.all(session.thunks.map(thunk => thunk()));
    });
  }

  /**
   * Resolve a query.
   *
   * This method ultimately delegates to a DataSource (for mutations) otherwise a DataLoader.
   *
   * @param {Query} query - The query to resolve
   * @returns {*} - The resolved query result
   */
  async resolve(query) {
    let thunk;
    const tquery = await query.transform();
    const oquery = Object.defineProperties(tquery.toObject(), {
      changeset: {
        get: function get() {
          return oquery.crud === 'update' ? Util.changeset(this.doc, this.input) : undefined;
        },
      },
    });
    const model = this.#schema.models[oquery.model];
    const currSession = this.#sessions.slice(-1).pop();

    if (oquery.isMutation) {
      thunk = () => model.source.client.resolve(tquery.toDriver().toObject()).then((results) => {
        // We clear the cache immediately (regardless if we're in transaction or not)
        this.clear(model);

        // If we're in a transaction, we clear the cache of all sessions when this session resolves
        currSession?.thunks.push(...this.#sessions.map(s => () => s.parent.clear(model)));

        // Return results
        return results;
      });
    } else {
      thunk = () => this.#dataLoaders[model].resolve(tquery);
    }

    return this.#createSystemEvent(tquery, () => {
      return thunk().then((result) => {
        if (oquery.flags?.required && (result == null || result?.length === 0)) throw Boom.notFound();
        return this.toResultSet(model, result, tquery.toObject());
      });
    });
  }

  toResultSet(model, result) {
    const self = this;
    if (result == null) return result;
    if (typeof result !== 'object') return result;
    return Object.defineProperties(Util.map(result, (doc) => {
      const $doc = this.#schema.models[model].walk(doc, node => node.value !== undefined && Object.assign(node, { key: node.field.name }), { key: 'key' });
      return Object.defineProperties($doc, {
        $: {
          get: () => {
            return new Proxy(this.match(model).id($doc.id), {
              get(queryResolver, cmd, proxy) {
                return (...args) => {
                  switch (cmd) {
                    case 'save': {
                      return queryResolver.save({ ...$doc, ...args[0] });
                    }
                    case 'lookup': {
                      const field = self.toModel(model).fields[args[0]];
                      const where = { [field.linkBy]: $doc[field.linkField.name] };
                      return self.match(field.model).where(where);
                    }
                    default: {
                      queryResolver = queryResolver[cmd](...args);
                      return queryResolver instanceof Promise ? queryResolver : proxy;
                    }
                  }
                };
              },
            });
          },
        },
        $model: { value: model },
        $cursor: { value: doc.$cursor },
      });
    }), {
      $pageInfo: { value: result.$pageInfo },
    });
  }

  toModel(model) {
    return typeof model === 'string' ? this.#schema.models[model] : model;
  }

  #createDataLoaders() {
    return Object.entries(this.#schema.models).filter(([key, value]) => {
      return value.loader && value.isEntity;
    }).reduce((prev, [key, value]) => {
      return Object.assign(prev, { [key]: new DataLoader(value) });
    }, {});
  }

  #createSystemEvent(tquery, thunk = () => {}) {
    const query = tquery.toObject();
    const type = query.isMutation ? 'Mutation' : 'Query';
    const event = { schema: this.#schema, context: this.#context, resolver: this, query };

    return Emitter.emit(`pre${type}`, event).then(async (resultEarly) => {
      if (resultEarly !== undefined) return resultEarly;
      if (Util.isEqual(query.changeset, { added: {}, updated: {}, deleted: {} })) return query.doc;
      if (query.isMutation) query.input = await tquery.pipeline('input', query.input, ['$finalize']);
      if (query.isMutation) await Emitter.emit('finalize', event);
      return thunk().then((result) => {
        query.result = result;
        return Emitter.emit(`post${type}`, event);
      });
    }).then((result = query.result) => {
      query.result = result;
      return Emitter.emit('preResponse', event);
    }).then((result = query.result) => {
      query.result = result;
      return Emitter.emit('postResponse', event);
    }).then((result = query.result) => result).catch((e) => {
      const { data = {} } = e;
      throw Boom.boomify(e, { data: { ...event, ...data } });
    });
  }

  static $loader(name, resolver, config) {
    if (!name) return loaders;
    if (!resolver) return loaders[name];
    return (loaders[name] = new Loader(resolver, config));
  }
};
