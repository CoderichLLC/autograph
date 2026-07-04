const { graphql } = require('graphql');
const Boom = require('@hapi/boom');
const Util = require('@coderich/util');
const QueryResolver = require('../query/QueryResolver');
const QueryPlanner = require('../query/QueryPlanner');
const Emitter = require('./Emitter');
const Loader = require('./Loader');
const DataLoader = require('./DataLoader');
const TransactionScope = require('./TransactionScope');
const Pipeline = require('./Pipeline');
const { inspect, buildSelectionTree } = require('../service/AppService');
const { $QUERY, $RAW } = require('../service/Symbols');
const { PreOperationError, PostOperationError } = require('../service/ErrorService');

const loaders = {};

module.exports = class Resolver {
  #schema;
  #xschema;
  #context;
  #dataLoaders;
  #queryPlanner; // lazy — created on first read (needs `this` fully constructed)
  #docClasses = {}; // Per-(resolver, model) Class cache — prototype hosts $, $model, $save, $lookup
  #transactionScope; // Active TransactionScope this resolver falls back to when nothing more specific is ambient

  // `register: false` is for clone()'s use only — a clone (isolated transaction, or an internal
  // *Many/RI auto-wrap) is a temporary, scoped resolver the caller holds a direct reference to
  // (`txn`) and is expected to use explicitly, never through `context.autograph.resolver`. Without
  // this, every clone's construction would silently and permanently repoint
  // context.autograph.resolver at itself — including for any *Many/RI wrap, so effectively any
  // mutation — leaving custom resolvers/hooks that read `context.autograph.resolver` fresh (not a
  // captured `event.resolver` snapshot) pointed at an orphaned clone, for the rest of the request.
  //
  // `dataLoaders`, if provided (clone()'s use), is SHARED by reference rather than rebuilt fresh —
  // DataLoaders are a per-request cache, not a per-transaction one; a clone that rebuilt its own
  // meant every isolated transaction (i.e. every RI/*Many auto-wrap) paid for cold cache misses on
  // data the calling resolver may have already fetched moments earlier, for no correctness benefit
  // — transactional read visibility is governed entirely by which DB session a query uses (see
  // TransactionScope#getSession), not by which DataLoader instance served it. Sharing also means
  // `this.clear(model)` (already called unconditionally after every write) transparently
  // invalidates the calling resolver's view too, immediately — no separate propagation needed.
  constructor({ schema, xschema, context, register = true, dataLoaders }) {
    this.#schema = schema.parse?.() || schema;
    this.#xschema = xschema;
    this.#context = context;
    this.#dataLoaders = dataLoaders ?? this.#createDataLoaders();
    this.model = this.match; // Alias
    if (register) Util.set(this.#context, `${this.#schema.namespace}.resolver`, this);
  }

  // One detached (scope-less) twin per REQUEST, not per resolver instance — keyed by the shared
  // #dataLoaders map, which is the one identity every clone of a request has in common (see
  // clone()). Events fired from an RI/*Many wrap carry the txn CLONE as event.resolver; keying
  // by the loaders map means clone.detach() and the root resolver's detach() return the same
  // instance, which keeps Emitter memoization (keyed per resolver) stable across a request.
  static #detachedResolvers = new WeakMap();

  // The context handed to EVENT HOOKS, with the transport's resolver slot poisoned. There is no
  // legitimate hook-side use of `context[namespace].resolver`: it is a MUTABLE slot whose meaning
  // is a function of time (the operation-scope wrapper swaps a txn clone in per field and
  // restores it after — an un-awaited hook body may read the NEXT field's transaction), while
  // `event.resolver` is the exact identity the hook is entitled to (participant clone, detached
  // twin, settled scope). Every hook intent has a first-class expression — event.resolver,
  // .detach(), .transaction(), or the registration role (on* vs observe*) — so misuse fails
  // LOUDLY at access time
  // instead of nondeterministically joining the wrong unit. Only the event's view is guarded:
  // the real context object is untouched (transport code reads the live slot), every other
  // context property reads/writes straight through, and `event.resolver.getContext()` remains
  // the escape hatch to the real object. Memoized per context so event identity is stable.
  static #guardedContexts = new WeakMap();

  static #guardedNamespaces = new WeakMap(); // namespace object -> its poisoned proxy (stable identity, zero steady-state allocation)

  static #guardContext(context, namespace) {
    if (context === null || typeof context !== 'object') return context;
    let guarded = Resolver.#guardedContexts.get(context);
    if (!guarded) {
      const poison = () => {
        throw new Error(`context.${namespace}.resolver is not accessible from event hooks — it is the transport's time-sensitive slot. Use event.resolver: participants (Emitter.on*) hold the carrying unit; observers (Emitter.observe*) hold the detached twin; use event.resolver.transaction() or event.resolver.detach() for new units of work.`);
      };
      const handler = {
        get: (target, prop) => (prop === 'resolver' ? poison() : target[prop]),
        set: (target, prop, value) => {
          if (prop === 'resolver') poison();
          target[prop] = value;
          return true;
        },
      };
      guarded = new Proxy(context, {
        get: (target, prop) => {
          const value = target[prop];
          if (prop !== namespace || value === null || typeof value !== 'object') return value;
          let ns = Resolver.#guardedNamespaces.get(value);
          if (!ns) {
            ns = new Proxy(value, handler);
            Resolver.#guardedNamespaces.set(value, ns);
          }
          return ns;
        },
      });
      Resolver.#guardedContexts.set(context, guarded);
    }
    return guarded;
  }

  #isDetached = false; // true only on instances created BY detach() — they are their own twin

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
    // The detached twin (see detach()) deliberately does NOT share this loaders map, so writes
    // must invalidate its cache explicitly — keyed by the shared map, so a write through any
    // clone of this request reaches the same detached instance.
    Resolver.#detachedResolvers.get(this.#dataLoaders)?.clear(model);
    return this;
  }

  clearAll() {
    Object.values(this.#dataLoaders).forEach(loader => loader.clearAll());
    Resolver.#detachedResolvers.get(this.#dataLoaders)?.clearAll();
    return this;
  }

  clone() {
    return new Resolver({
      schema: this.#schema,
      xschema: this.#xschema,
      context: this.#context,
      register: false,
      dataLoaders: this.#dataLoaders,
    });
  }

  /**
   * The detached twin of this resolver — no transaction scope, ever. Reads are sessionless
   * (committed state only); writes land immediately and unconditionally, outside any transaction
   * that may be ambient on this resolver, and therefore survive its rollback.
   *
   * This is what the Emitter hands to OBSERVERS (Emitter.observe*) in place of the ambient
   * resolver: a fire-and-forget listener is structurally incapable of being awaited, so it can
   * never be a transaction participant — the unit of work is exactly what the mutation awaits.
   * Handing un-awaitable work a sessioned resolver made its writes race the carrying
   * transaction's settle for membership (sometimes in, sometimes silently dropped); detachment
   * turns that nondeterminism into a deterministic contract. A hook whose write must share the
   * mutation's fate must be a participant (Emitter.on*), which still receives the ambient
   * resolver.
   *
   * Unlike clone(), the detached twin gets FRESH DataLoaders: the ambient resolver's shared
   * cache can hold raw results fetched through an open transaction's session (uncommitted-view
   * data), which a sessionless consumer must never be served. Writes through any resolver of
   * the request still invalidate the twin's cache (see clear()), so it never serves stale
   * committed state either. Memoized per request — see #detachedResolvers.
   */
  detach() {
    // A detached twin is its own twin — it can never acquire a scope, so events fired from its
    // writes hand it straight back instead of minting a twin-of-twin. (A merely scope-LESS
    // resolver doesn't qualify: the ambient resolver can acquire a scope mid-request — e.g. the
    // operation scope — and a captured reference to it must not silently become transactional.)
    if (this.#isDetached) return this;

    let detached = Resolver.#detachedResolvers.get(this.#dataLoaders);
    if (!detached) {
      detached = new Resolver({
        schema: this.#schema,
        xschema: this.#xschema,
        context: this.#context,
        register: false,
      });
      detached.#isDetached = true;
      Resolver.#detachedResolvers.set(this.#dataLoaders, detached);
    }
    return detached;
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
   * @returns {QueryResolver} - An API to build and execute a query
   */
  match(model) {
    return new QueryResolver({
      resolver: this,
      schema: this.#schema,
      context: this.#context,
      query: { model: `${model}` },
    });
  }

  /**
   * This resolver's own TransactionScope, if any — set by a prior
   * `.transaction()`/`.withTransaction()` call on this exact reference (a host uses
   * `transaction({ isolated: false })` for an in-place, whole-request scope — §4.7's escape
   * hatch). Read directly (no ambient lookup) by `resolve()`, by QueryResolver's RI/*Many
   * auto-wrap when it calls `.withTransaction()` on this resolver to find its parent, and by
   * the operation-scope wrapper to detect a host-managed scope it must stand down for (see
   * OperationScope.js).
   */
  get transactionScope() {
    return this.#transactionScope;
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
   * Start (or join) a transaction — an explicit "break out into my own transaction" demarcation.
   *
   * There is no ambient/implicit context here: "join" means calling `.transaction()` on whichever
   * resolver reference you already have (this resolver, or a `txn` returned by an earlier
   * `.transaction()`/`.withTransaction()` call) — that reference's own `#transactionScope` is the
   * parent. This mirrors how `resolver.match()` itself works: always through an explicit reference,
   * never a hidden global.
   *
   * @param {object} options
   * @param {boolean} options.isolated - Run in a cloned resolver (default true). The clone shares
   *   this resolver's DataLoaders (a per-request cache, not a per-transaction one — see clone())
   *   but gets its own `#transactionScope` field. Always clone for anything that might run
   *   concurrently with sibling code sharing this same resolver instance (e.g. two postMutation
   *   hooks on the same event) — mutating this resolver's own `#transactionScope` in place
   *   (isolated: false) is only safe when you know nothing else concurrently holds this exact
   *   reference. `isolated: false` on a request resolver is the HOST escape hatch (§4.7): a host
   *   that assembles its own executable schema (bypassing Schema#toObject's operation-scope
   *   wrap) scopes the whole request in place this way, OWNS its settle (`commit()`/`rollback()`
   *   at a deterministic completion point), and the operation-scope wrapper stands down whenever
   *   it finds the resulting open scope.
   * @param {boolean} options.coupled - Offer this resolver's own scope as parent, accepting
   *   whatever relationship the driver hands back (default true) — on MongoDB that's always the
   *   same physical session, so rolling back propagates to the parent. Pass false to force a
   *   wholly independent transaction, unrelated to this resolver's own scope.
   * @returns {Resolver} - the resolver to call .match()/.commit()/.rollback() on
   */
  transaction({ isolated = true, coupled = true } = {}) {
    // A settled scope is no longer "ambient" — a new transaction started after commit()/rollback()
    // is a fresh top-level unit, not a child of something that no longer exists.
    const parent = this.#transactionScope?.state === 'open' ? this.#transactionScope : undefined;
    // Replacing an ACTIVE scope in place would orphan it: this resolver's commit()/rollback()
    // would from then on reach only the new (coupled, no-op-commit) child, leaving the original
    // transaction unreachable and uncommitted until the driver's own timeout aborts it.
    if (!isolated && parent) throw new Error('Resolver already has an active transaction scope; transaction({ isolated: false }) would orphan it. Use isolated: true (the default), or settle the current transaction first.');
    // The detached twin must never carry a scope in place — other fire-and-forget listeners
    // share this exact instance; an explicit unit of work inside a hook uses the default
    // (isolated) form, which scopes a CLONE.
    if (!isolated && this.#isDetached) throw new Error('Cannot scope a detached resolver in place; use isolated: true (the default) for an explicit unit of work.');
    const target = isolated ? this.clone() : this;
    // Every scope binds a real session on its FIRST operation, read or write — not just its
    // first write. You asked for a transaction; a plain BEGIN in any database starts a real one
    // whether or not you end up writing — reads through it get real snapshot-isolated visibility
    // for its whole lifetime, not just read-your-own-writes bolted onto whatever a write
    // happened to bind. (A lazy variant — reads never bind — existed for the removed
    // request-lifetime autoTransaction mode and died with it.)
    target.#transactionScope = new TransactionScope({ parent: coupled ? parent : null, independent: !coupled });
    return target;
  }

  /**
   * Commit this resolver's active transaction, if any. A no-op if this resolver never got a
   * scope (`.transaction()` was never called on it — the common case for read-only requests).
   */
  commit() {
    return this.#transactionScope ? this.#transactionScope.commit() : Promise.resolve();
  }

  /**
   * Roll back this resolver's active transaction, if any.
   */
  rollback() {
    return this.#transactionScope ? this.#transactionScope.rollback() : Promise.resolve();
  }

  /**
   * Convenience wrapper around .transaction()/.commit()/.rollback() for the common case: run
   * `fn` against a transactional resolver, commit if it resolves, roll back and rethrow if it
   * rejects. Equivalent to the manual pattern:
   *
   *   const txn = resolver.transaction(options);
   *   try { const result = await fn(txn); await txn.commit(); return result; }
   *   catch (e) { await txn.rollback(); throw e; }
   *
   * Prefer `.transaction()` directly when you need custom error handling (e.g. deciding NOT to
   * roll back on a specific caught error) — this helper always rolls back on any rejection.
   *
   * This is also exactly what QueryResolver's internal RI/*Many auto-wrap calls — autograph
   * manages its own transactions through the same public API a manual caller uses, not a separate
   * mechanism. It always passes `{ isolated: true }` for the reason noted on `.transaction()`
   * above: the auto-wrap can be triggered from code sharing a resolver instance with concurrent
   * siblings (e.g. two postMutation hooks on the same event), so it must never mutate that shared
   * instance's own `#transactionScope` — cloning is what makes that safe.
   *
   * @param {Function} fn - (txnResolver) => Promise<*>
   * @param {object} options - Same as .transaction()'s options ({ isolated, coupled })
   * @returns {*} - fn's resolved value
   */
  async withTransaction(fn, options) {
    const txn = this.transaction(options);
    try {
      const result = await fn(txn);
      await txn.commit();
      return result;
    } catch (e) {
      // The underlying write(s) already succeeded — only a PRESENTER-phase hook (preResponse/
      // postResponse) failed, or a write on a source that doesn't support transactions had a
      // post-phase failure (see the role-graded post* phase in #createSystemEvent; a participant
      // (postMutation) failure on a carried write arrives here UNWRAPPED and takes the rollback
      // path below). There is nothing to undo; commit anyway and surface it to the caller. Thrown
      // as-is (not unwrapped to `.data`) so callers get the same shape here as for a plain,
      // non-wrapped mutation's own PostOperationError — `.data` for the original cause, `.result`
      // for what was actually written despite the error (settleMany/#resolveReferentialIntegrity
      // populate `.result` positionally across the whole batch/cascade, not just one element).
      if (e instanceof PostOperationError) {
        await txn.commit();
        throw Boom.boomify(e);
      }
      // Never let a secondary rollback failure (e.g. a session the original error already aborted
      // server-side) mask the root cause — the original rejection is what the caller can act on.
      await txn.rollback().catch(() => {});
      throw e;
    }
  }

  /**
   * Resolve a query.
   *
   * This method ultimately delegates to a DataSource (for mutations) otherwise a DataLoader.
   *
   * @param {Query} query - The query to resolve
   * @returns {*} - The resolved query result
   */
  // async (even though nothing here is awaited): #createSystemEvent's $query.transform(false)
  // can throw synchronously on a bad transformer — needs the implicit try/catch an async function
  // wraps its body in, or a synchronous throw would propagate as a thrown exception out of
  // resolve() instead of a rejected promise, unlike every other error path here.
  async resolve(query) {
    const { doc, model, crud, isMutation, flags } = query.toObject();

    // This resolver's own scope (set by a prior .transaction() call — e.g. a gqlMutation's field
    // clone, or a host's in-place transaction({ isolated: false })) — safe to read directly, no
    // ambient lookup needed. Anything that wants a *different* scope (RI/*Many's auto-wrap, a manual
    // nested transaction) gets there by calling .transaction()/.withTransaction() on the specific
    // resolver reference it holds, the same way any caller would — see QueryResolver's #withTransaction usage.
    const scope = this.#transactionScope;

    let thunk;

    if (isMutation) {
      thunk = (tquery) => {
        const { client, supports } = this.#schema.models[model].source;
        const driverQuery = tquery.toDriver().toObject();
        // Only a data source that actually advertises transaction support participates in this
        // resolver's scope — a scope expresses intent, not capability a
        // given source doesn't have.
        const useScope = scope && supports.includes('transactions') ? scope : undefined;

        const dispatch = () => {
          const plan = client.prepare(driverQuery);
          if (driverQuery.flags?.debug) inspect(plan);
          return client.execute(plan);
        };

        const executed = useScope
          ? useScope.getSession(client).then((session) => {
            driverQuery.options = { ...driverQuery.options, session };
            // TransactionScope.run routes to whichever scope actually OWNS this session's queue —
            // the single serialization front door shared with sessioned reads (see DataLoader).
            return TransactionScope.run(session, dispatch);
          })
          : dispatch();

        return executed.then((results) => {
          // Clones share DataLoaders with whatever resolver they were cloned from (see clone()),
          // so this transparently invalidates every reader's view too, immediately — no separate
          // propagation needed for isolated transactions.
          this.clear(model);

          // But a read through the shared cache can still land in the window between this
          // immediate clear and the transaction's real, final commit — caching a pre-commit view
          // that would otherwise never get invalidated. Clear again once this write's session is
          // truly, finally sealed (a no-op until then if nothing re-caches it in the meantime).
          // Keyed so N writes to one model register one settle-time clear, not N.
          if (useScope) useScope.addSettled(client, () => this.clear(model), `clear:${model}`);

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

        const dispatch = () => {
          this.#queryPlanner ??= new QueryPlanner(this.#schema, this);
          return this.#queryPlanner.resolve(model, tquery, rq => this.#dataLoaders[model].resolve(rq));
        };

        // A SETTLED scope degrades reads to plain (committed-state, sessionless) reads rather
        // than erroring: docs returned from a transaction lazily resolve their populated fields
        // through the same (cloned, now-settled) resolver during response serialization — after
        // withTransaction/commit() already sealed the session. Writes stay strict (getSession on
        // a settled scope throws a clear AG-level error) — a stale write is a caller bug; a
        // post-commit read of committed state is not.
        if (!scope || scope.state !== 'open') return dispatch();
        const { supports, client } = this.#schema.models[model].source;
        if (!supports.includes('transactions')) return dispatch();

        // An open scope binds a session on first use, read or write, so it gets a real,
        // snapshot-isolated view for its whole lifetime — a transaction's reads are part of the
        // transaction, the same way BEGIN makes them in any database.
        return scope.getSession(client).then((session) => {
          if (session) tquery.toObject().options = { ...tquery.toObject().options, session };
          return dispatch();
        });
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
    Doc.docToString = function docToString() { return `${model}`; };

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

  // async: needed so a synchronous throw anywhere in this body (e.g. $query.transform(false),
  // or a synchronously-throwing basic-style listener) converts to a rejection like every other
  // error path here, rather than propagating as a thrown exception out of #createSystemEvent.
  async #createSystemEvent($query, thunk = () => {}) {
    const tquery = $query.transform(false);
    const query = tquery.toObject();
    const type = query.isMutation ? 'Mutation' : 'Query';
    const needsValidate = (query.crud === 'create' || query.crud === 'update') && !query.isSaveNative;

    // Hot-path bypass: when no listener's model/key filter matches this query (and no
    // validation work to do), skip the entire emit chain. Each skipped emit avoids: an event-
    // object allocation, an Emitter cache lookup, a Promise.resolve, and a .then microtask.
    // For a wide read like findNetworkPlace with thousands of inner sub-resolvers
    // (Category/Image/Workspace) that have no relevant hooks, this is a real win.
    const { model: qModel } = query;
    if (
      !needsValidate
      && !Emitter.hasListenersFor(`pre${type}`, qModel)
      && !Emitter.hasListenersFor(`post${type}`, qModel)
      && !Emitter.hasListenersFor('preResponse', qModel)
      && !Emitter.hasListenersFor('postResponse', qModel)
      // Mutations only: postCommit/postRollback need the full path (an event object to emit with,
      // and the settled registration below). Reads keep their 4-lookup hot path.
      && (type === 'Query' || (!Emitter.hasListenersFor('postCommit', qModel) && !Emitter.hasListenersFor('postRollback', qModel)))
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
    const event = { schema: this.#schema, context: Resolver.#guardContext(this.#context, this.#schema.namespace), resolver: this, query, [$QUERY]: tquery };

    // pre* phase: preMutation + validate, both BEFORE the write. A failure here means the write
    // never even happened — always rollback-worthy. Wrapped in PreOperationError purely so a
    // pre-write failure is symmetrically identifiable by phase, same as PostOperationError below;
    // the commit/rollback decision itself doesn't need to check for it — "anything that isn't a
    // PostOperationError" already means rollback (see Resolver#withTransaction).
    let resultEarly;
    try {
      resultEarly = await Emitter.emit(`pre${type}`, event);
      if (resultEarly === undefined && needsValidate) {
        tquery.validate(); // sets async $thunks (e.g. ensureFK)
        await Promise.all([...query.input.$thunks]);
        await Emitter.emit('validate', event);
      }
    } catch (e) {
      throw Boom.boomify(e instanceof PreOperationError ? e : new PreOperationError(e));
    }

    // The actual write. Failures here propagate unwrapped, straight to the caller — always
    // rollback-worthy by default; there's no hook to attribute the failure to.
    const result = resultEarly !== undefined ? resultEarly : await Promise.resolve(thunk(tquery)).catch((e) => { throw Boom.boomify(e); });
    query.result = result;

    // Whether a transaction scope carried this write — the same condition the write's dispatch
    // used in resolve(). Decides two things below: where postCommit/postRollback fire (at the
    // scope's true settle vs the end of this lifecycle), and what a postMutation failure means
    // (abort the unit vs surface-but-keep an already-durable write).
    const carried = type === 'Mutation' && resultEarly === undefined
      && Boolean(this.#transactionScope) && this.#schema.models[qModel].source.supports.includes('transactions');

    // postCommit / postRollback — the durable-outcome events. Uniform contract: postCommit means
    // "this write is durable" (the transaction it rode in truly, finally committed — or it never
    // rode in one and was durable the moment the driver returned); postRollback means "this write
    // was undone" (compensation hook). Both are fire-and-forget by nature: there is no caller
    // left to veto or shape anything, so listener failures are isolated — they can never reject a
    // commit() or a mutation that already succeeded. Registered only when the write actually
    // executed (a preMutation short-circuit writes nothing — there is no durable outcome to
    // announce). Granularity matches postMutation: per query — a *Many batch or RI cascade emits
    // one event per element/step, at the moment the whole unit's fate is sealed.
    //
    // REGISTRATION ONLY — nothing is emitted here. Both branches defer: addSettled fires at the
    // scope's true settle; emitDurable is invoked at the END of the post* phase below. Firing
    // order is therefore always postMutation -> preResponse -> postResponse -> postCommit, in
    // both paths. Registration must happen HERE (at write success, before the post* phase) so
    // that a participant (postMutation) failure that aborts the unit still emits postRollback
    // for this write — it happened, then was undone; that's exactly what compensation hooks need.
    let emitDurable; // set when NO transaction scope carried this write (durable right now)
    if (type === 'Mutation' && resultEarly === undefined
      && (Emitter.hasListenersFor('postCommit', qModel) || Emitter.hasListenersFor('postRollback', qModel))) {
      const emitSettled = eventName => Promise.resolve().then(() => Emitter.emit(eventName, event)).catch(() => {});
      if (carried) {
        // Defer to the session's true settle. For a gqlMutation that's its field scope's commit
        // (per field — or the LAST root field's, under @transaction); for an RI/*Many wrap it's
        // the wrapper's own commit after every element's full lifecycle.
        this.#transactionScope.addSettled(this.#schema.models[qModel].source.client, outcome => emitSettled(outcome === 'commit' ? 'postCommit' : 'postRollback'));
      } else {
        // No transaction carried this write — it is already durable. Emitted at the END of the
        // post* phase below (not here), so postCommit always fires after postMutation/preResponse/
        // postResponse in both the transactional and non-transactional paths.
        emitDurable = () => emitSettled('postCommit');
      }
    }

    // post* phase, role-graded (see TRANSACTIONS.md §4.15):
    //
    // postMutation is the PARTICIPANT phase — the hook is part of the unit of work (audit rows,
    // denormalized counters, derived writes, deferred invariant checks), so its failure means the
    // unit is INCOMPLETE. When a transaction carried the write, the failure propagates unwrapped
    // and ABORTS the unit — the same treatment as a failure of the write itself. (A hook that
    // prefers best-effort tolerance opts out with its own try/catch; a hook whose failure should
    // never abort anything is an observer and belongs in postCommit.) When nothing carried the
    // write, it is already durable and physically cannot be undone — the failure surfaces as
    // PostOperationError with `.result` so the caller knows both facts. A PostOperationError
    // passing through here (e.g. a nested mutation inside the hook that failed only its own
    // presenter phase) stays a PostOperationError — that nested write IS complete; only its
    // presentation failed.
    let shortCircuited = false;
    try {
      const early = await Emitter.emit(`post${type}`, event);
      if (early !== undefined) {
        query.result = early;
        shortCircuited = true;
      }
    } catch (e) {
      if (carried) throw Boom.boomify(e);
      const err = Boom.boomify(e instanceof PostOperationError ? e : new PostOperationError(e, query.result));
      if (emitDurable) await emitDurable(); // the bare write is durable regardless — announce it
      throw err;
    }

    // RESPONSE layer (see TRANSACTIONS.md §4.16). Failures here are never rollback-worthy —
    // the data is correct and committed (or committing); only the response work failed. Always
    // PostOperationError, so Resolver#withTransaction commits anyway and re-throws.
    //
    // - preResponse is the PRESENTER — the last chance to SHAPE what the caller is told. Skipped
    //   if postMutation already short-circuited with an explicit replacement result (unchanged).
    // - postResponse is the RESPONSE OBSERVER — it ALWAYS fires, last, with the settled result,
    //   regardless of upstream short-circuits (an observer that misses exactly the overridden
    //   responses would be useless), and as a PURE observer its return value is deliberately
    //   ignored — it cannot reshape what it is witnessing. It observes the response layer only
    //   (what the caller was told); whether that became durably true is the durability layer's
    //   observers (postCommit/postRollback). It does not fire on error paths — an errored
    //   mutation sends no result out the door for it to observe.
    try {
      if (!shortCircuited) {
        const early = await Emitter.emit('preResponse', event);
        if (early !== undefined) query.result = early;
      }
      await Emitter.emit('postResponse', event);
      if (emitDurable) await emitDurable();
      return query.result;
    } catch (e) {
      const err = Boom.boomify(e instanceof PostOperationError ? e : new PostOperationError(e, query.result));
      // A response-layer failure is not a data failure — the write is still durable, so the
      // durable-outcome event still fires (its listeners are isolated; this cannot mask `err`).
      if (emitDurable) await emitDurable();
      throw err;
    }
  }

  static $loader(name, resolver, config) {
    if (!name) return loaders;
    if (!resolver) return loaders[name];
    return (loaders[name] = new Loader(resolver, config));
  }
};
