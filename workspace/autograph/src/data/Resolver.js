const { graphql } = require('graphql');
const Boom = require('@hapi/boom');
const Util = require('@coderich/util');
const QueryResolver = require('../query/QueryResolver');
const Emitter = require('./Emitter');
const Loader = require('./Loader');
const DataLoader = require('./DataLoader');
const Transaction = require('./Transaction');
const Pipeline = require('./Pipeline');
const { inspect, buildSelectionTree } = require('../service/AppService');
const { $QUERY, $RAW } = require('../service/Symbols');

const loaders = {};

module.exports = class Resolver {
  #schema;
  #xschema;
  #context;
  #dataLoaders;
  #docClasses = {}; // Per-(resolver, model) Class cache — prototype hosts $, $model, $save, $lookup
  #sessions = []; // Holds nested 2D array of transactions

  constructor({ schema, xschema, context }) {
    this.#schema = schema.parse?.() || schema;
    this.#xschema = xschema;
    this.#context = context;
    this.#dataLoaders = this.#createDataLoaders();
    this.model = this.match; // Alias
    Util.set(this.#context, `${this.#schema.namespace}.resolver`, this);
  }

  getSchema() {
    return this.#schema;
  }

  getContext() {
    return this.#context;
  }

  // Public accessor for #context. AG12 exposed `resolver.context` as a public, re-assignable
  // property; consumers rely on re-pointing it after their server framework swaps the context
  // object (e.g. Apollo Server shallow-copies the context — apollographql/apollo-server#3146 —
  // so the object resolvers receive differs from the one this Resolver was constructed with).
  // Restoring the setter keeps `event.context` pointed at the live, mutated context.
  get context() {
    return this.#context;
  }

  set context(context) {
    this.#context = context;
    Util.set(this.#context, `${this.#schema.namespace}.resolver`, this);
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
      xschema: this.#xschema,
      context: this.#context,
    });
  }

  driver(model) {
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
    return this.#sessions.at(-1)?.at(-1)?.match(model) ?? new QueryResolver({
      resolver: this,
      schema: this.#schema,
      context: this.#context,
      query: { model: `${model}` },
    });
  }

  /**
   * Execute a user-defined loader (curry in context)
   */
  loader(name) {
    const context = this.#context;

    return new Proxy(loaders[name], {
      get(loader, fn, proxy) {
        if (fn.startsWith('load')) return args => loader[fn](args, context);
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

    const currSession = this.#sessions.at(-1);
    const currTransaction = currSession?.at(-1);
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
    return promise.catch((e) => {
      return this.rollback().then(() => Promise.reject(e));
    }).then((results) => {
      return this.commit().then(() => results);
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
      return transaction.rollback().catch(e => errors.push(e));
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
    const { doc, model, crud, isMutation, flags } = query.toObject();
    const currSession = this.#sessions.at(-1);

    if (isMutation) {
      thunk = (tquery) => {
        const { client } = this.#schema.models[model].source;
        const driverQuery = tquery.toDriver().toObject();
        const plan = client.prepare(driverQuery);
        if (driverQuery.flags?.debug) inspect(plan);

        return client.execute(plan).then((results) => {
          // We clear the cache immediately (regardless if we're in transaction or not)
          this.clear(model);

          // If we're in a transaction, we clear the cache of all sessions when this session resolves
          currSession?.thunks.push(...this.#sessions.map(s => () => s.parent.clear(model)));

          // Return results
          if (crud === 'delete') return doc;
          // Pass mutation's selection set through so the returned doc applies the same eager/lazy
          // split as reads. Mutations have info too — caller uses .info(info) before save/delete.
          return this.toResultSet(model, results, query.toObject().info);
        });
      };
    } else {
      thunk = (tquery) => {
        const { where, op } = query.toObject();
        const values = Object.values(where);
        const $values = values.flat();
        const skipQuery = values.length && (!$values.length || $values.includes(undefined));

        if (skipQuery) {
          switch (op) {
            case 'count': return Promise.resolve(0);
            case 'findMany': return Promise.resolve([]);
            default: return Promise.resolve(null);
          }
        }

        return this.#dataLoaders[model].resolve(tquery);
      };
    }

    return this.#createSystemEvent(query, (tquery) => {
      return thunk(tquery).then((result) => {
        if (flags?.required && (result == null || result?.length === 0)) throw Boom.notFound(`${model} Not Found`);
        return result;
      }).finally(() => {
        query.resolve();
      });
    });
  }

  toResultSet(model, result, info) {
    if (result == null) return result;
    if (typeof result !== 'object') return result;
    model = this.#schema.models[model];
    const DocClass = this.getDocClass(model);
    const proto = DocClass.prototype;
    // Parse the GraphQL selection once per call. If info is missing (legacy callers, internal
    // recursion paths), selection will be null and docTransform falls back to all-lazy.
    const selection = buildSelectionTree(info, model.name);

    return Object.defineProperties(Util.map(result, (doc) => {
      // docTransform creates the object with DocClass.prototype set at allocation time,
      // so we avoid setPrototypeOf (deopt) and per-doc defineProperties for $/$model/etc.
      // Selection is passed as the third arg (rather than embedded in args) so internal
      // recursion can swap it without spreading args on every call.
      const $doc = model.docTransform(doc, { resolver: this, context: this.#context }, selection);

      // Safety: already-$transformed docs early-return from docTransform without the new
      // prototype. Patch it here — rare path; the common path takes Object.getPrototypeOf===proto.
      if (Object.getPrototypeOf($doc) !== proto) Object.setPrototypeOf($doc, proto);

      // toString MUST stay per-instance, not on the prototype: @coderich/util's
      // isPlainObject() calls `proto.toString.call(obj)` looking for "[object Object]".
      // A prototype-level toString returning the model name would defeat that check and
      // break Util.pathmap / Util.flatten / unflatten across pull/splice/save paths.
      Object.defineProperty($doc, 'toString', { value: DocClass.docToString });

      // $cursor is per-instance; only set if the driver returned one
      if (doc.$cursor !== undefined) Object.defineProperty($doc, '$cursor', { value: doc.$cursor });
      return $doc;
    }), {
      $pageInfo: { value: result.$pageInfo },
    });
  }

  // Build (and cache) a Doc class for a given model. The class's prototype hosts the
  // shared $ getter, $model, $save, $lookup (one closure-set per (resolver, model), not per-doc).
  // Doc.lazyGetters holds shared getter functions for transform-eligible fields — re-used by
  // every doc instance via Object.defineProperty on the instance (so spread/iteration still
  // fires them), saving the closure allocation that the previous per-doc-getter pattern paid.
  getDocClass(model) {
    const cached = this.#docClasses[model.name];
    if (cached) return cached;

    const self = this;

    class Doc {}

    // toString is intentionally NOT on the prototype — see toResultSet for the reason.
    // We stash one shared instance here so per-doc defineProperty reuses the same function.
    Doc.docToString = function () { return `${model}`; };

    Object.defineProperties(Doc.prototype, {
      $model: { value: model },
      $: {
        get() {
          const $doc = this;
          return new Proxy(self.match(model).id($doc.id), {
            get(queryResolver, cmd, proxy) {
              return (...args) => {
                switch (cmd) {
                  case 'save': {
                    return queryResolver.save({ ...$doc, ...args[0] }); // $doc incase it's mutated
                  }
                  case 'lookup': {
                    const field = self.toModel(model).fields[args[0]];
                    const where = field.isVirtual ? { [field.linkBy]: $doc[field.linkField] } : { [field.fkField]: $doc[field] };
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
      // Backwards compat — these used to be per-doc arrow closures; now shared on prototype
      $save: { value(...args) { return this.$.save(...args); } },
      $lookup: { async value(prop, args) {
        const field = model.fields[prop];
        const method = field.isArray ? 'many' : 'one';
        return this.$.lookup(prop).args(args)[method]();
      } },
    });

    // Shared lazy getters/setters — one pair per (resolver, model, field). The doc instance
    // only needs an own accessor descriptor pointing at these functions; no per-doc closure
    // required.
    //
    // Getter: read raw value from this[$RAW], run the transform pipeline, memoize as an own
    // data property (self-replace), return value. Subsequent reads are direct data property
    // access (no getter dispatch).
    //
    // Setter: a lazy property with no setter would throw "Cannot set property ... which has
    // only a getter" if anything writes before reading (hooks doing `doc.name = X`, the
    // `$.save({...$doc, ...})` proxy, internal in-place mutations like pull/push/splice).
    // We install a shared setter that overwrites the accessor with a writable data property
    // holding the new value — bypassing the getter entirely. Same self-replace pattern, just
    // driven by writes instead of reads.
    //
    // cachedArgs is hoisted out of the getter — the resolver and context are stable for the
    // DocClass lifetime, so allocating once beats rebuilding on every getter fire.
    const cachedArgs = { resolver: self, context: self.getContext() };
    Doc.lazyGetters = {};
    Doc.lazySetters = {};
    Object.values(model.fields).forEach((docField) => {
      const hasEmbedded = docField.isEmbedded;
      const hasDeserialize = docField.pipelines?.deserialize?.length > 0;
      if (!hasEmbedded && !hasDeserialize) return;
      const fieldRef = docField;
      const fieldName = docField.name;
      Doc.lazyGetters[fieldName] = function lazyGetter() {
        const raws = this[$RAW];
        const raw = raws ? raws[fieldName] : undefined;
        let v = raw;
        if (hasEmbedded && v != null) v = Util.map(v, sv => fieldRef.model.docTransform(sv, cachedArgs));
        if (hasDeserialize) v = Pipeline.resolve({ ...cachedArgs, model, field: fieldRef, value: v }, 'deserialize');
        Object.defineProperty(this, fieldName, { value: v, writable: true, enumerable: true, configurable: true });
        return v;
      };
      Doc.lazySetters[fieldName] = function lazySetter(v) {
        Object.defineProperty(this, fieldName, { value: v, writable: true, enumerable: true, configurable: true });
      };
    });

    this.#docClasses[model.name] = Doc;
    return Doc;
  }

  toModel(model) {
    return typeof model === 'string' ? this.#schema.models[model] : model;
  }

  #createDataLoaders() {
    return Object.entries(this.#schema.models).filter(([key, value]) => {
      return value.loader && value.isEntity;
    }).reduce((prev, [key, value]) => {
      return Object.assign(prev, { [key]: new DataLoader(value, this) });
    }, {});
  }

  #createSystemEvent($query, thunk = () => {}) {
    const tquery = $query.transform(false);
    const query = tquery.toObject();
    const type = query.isMutation ? 'Mutation' : 'Query';
    const needsValidate = (query.crud === 'create' || query.crud === 'update') && !query.isSaveNative;

    // Hot-path bypass: when no listener's model/key filter matches this query (and no
    // validation work to do), skip the entire emit chain. Each skipped emit avoids: an event-
    // object allocation, an Emitter cache lookup, a Promise.resolve, and a .then microtask.
    // For a wide read like findNetworkPlace with thousands of inner sub-resolvers
    // (Category/Image/Workspace) that have no relevant hooks, this is a real win.
    const { model: qModel, key: qKey } = query;
    if (
      !needsValidate
      && !Emitter.hasListenersFor(`pre${type}`, qModel, qKey)
      && !Emitter.hasListenersFor(`post${type}`, qModel, qKey)
      && !Emitter.hasListenersFor('preResponse', qModel, qKey)
      && !Emitter.hasListenersFor('postResponse', qModel, qKey)
    ) {
      return Promise.resolve(thunk(tquery)).then((result) => {
        query.result = result;
        return result;
      }).catch((e) => { throw Boom.boomify(e); });
    }

    // event.query stays the plain mutable object listeners read/write. The Query instance is
    // attached under a Symbol-keyed slot — framework-internal handle the Emitter uses to call
    // toCacheKey() for memoization. Symbol key is invisible to spread/Object.keys/JSON.stringify
    // (same hygiene the old defineProperty pattern provided) and lets V8 keep the event
    // object's hidden class stable since the property is part of the initial object literal.
    const event = { schema: this.#schema, context: this.#context, resolver: this, query, [$QUERY]: tquery };

    return Emitter.emit(`pre${type}`, event).then(async (resultEarly) => {
      if (resultEarly !== undefined) return resultEarly;

      if (needsValidate) {
        tquery.validate(); // sets async $thunks (e.g. ensureFK)
        await Promise.all([...query.input.$thunks]);
        await Emitter.emit('validate', event);
      }

      return thunk(tquery);
    }).then((result) => {
      query.result = result;
      return Emitter.emit(`post${type}`, event);
    }).then((early) => {
      if (early !== undefined) query.result = early;
      return early !== undefined ? early : Emitter.emit('preResponse', event);
    }).then((early) => {
      if (early !== undefined) query.result = early;
      return early !== undefined ? early : Emitter.emit('postResponse', event);
    }).then((early) => {
      if (early !== undefined) query.result = early;
      return query.result;
    }).catch((e) => { throw Boom.boomify(e); });
  }

  static $loader(name, resolver, config) {
    if (!name) return loaders;
    if (!resolver) return loaders[name];
    return (loaders[name] = new Loader(resolver, config));
  }
};
