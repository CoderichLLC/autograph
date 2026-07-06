const get = require('lodash.get');
const Util = require('@coderich/util');
const QueryBuilder = require('./QueryBuilder');
const { PostOperationError } = require('../service/ErrorService');

// Runs a fan-out of independent per-element mutations (createMany/updateMany/etc's elements) to
// completion regardless of individual failures — never lets Promise.all's "first rejection wins"
// race mask a genuine failure behind an unrelated element's PostOperationError (a presenter-phase
// preResponse/postResponse failure — the element's data is complete and correct, only its
// presentation broke — which must not trigger a rollback; see Resolver#withTransaction). Any real
// failure anywhere in the batch — including a participant (postMutation) failure, which arrives
// unwrapped — still rolls back everything; a batch where the only failures are
// PostOperationErrors commits (every element's data is complete) and surfaces them to the caller
// as one PostOperationError (aggregated if there's more than one).
const settleMany = async (promises) => {
  const settled = await Promise.allSettled(promises);
  const real = settled.find(s => s.status === 'rejected' && !(s.reason instanceof PostOperationError));
  if (real) throw real.reason;

  // Positionally aligned with the input. An element rejected with a PostOperationError DID commit
  // its write (only its post-write hook failed) — its written result belongs in the recovery
  // payload (.result) just as much as a fully-clean element's does, or a caller reconciling
  // "what is actually in the database now" would undercount.
  const values = settled.map(s => (s.status === 'fulfilled' ? s.value : s.reason.result));
  const postFailures = settled.filter(s => s.status === 'rejected').map(s => s.reason.data);
  if (postFailures.length === 1) throw new PostOperationError(postFailures[0], values);
  if (postFailures.length > 1) throw new PostOperationError(new AggregateError(postFailures), values);
  return values;
};

module.exports = class QueryResolver extends QueryBuilder {
  #model;
  #schema;
  #config;
  #context;
  #resolver;
  #resolution = Promise.withResolvers(); // Promise for when the query is resolved

  constructor(config) {
    const { schema, context, resolver, query } = config;
    super(config);
    this.#config = config;
    this.#schema = schema;
    this.#context = context;
    this.#resolver = resolver;
    this.#model = schema.models[query.model];
  }

  promise() {
    return this.#resolution.promise;
  }

  terminate(queryOverride) {
    const query = super.terminate(queryOverride);
    query.promise().then(this.#resolution.resolve).catch(this.#resolution.reject);
    const { op, flags, args: { input } } = query.toObject();

    // Resolve
    switch (op) {
      case 'findOne': case 'findMany': case 'count': case 'createOne': {
        return this.#resolver.resolve(query);
      }
      case 'createMany': {
        return this.#resolver.withTransaction((txn) => {
          return settleMany(input.map(el => txn.match(this.#model.name).flags(flags).save(el)));
        });
      }
      case 'updateOne': {
        return this.#model.preImage(query, this.#resolver).then((doc) => {
          // undefined ⇔ elided: the 404 contract rides flags.required against the driver's
          // returned post-image instead of the pre-fetch (same error class and message).
          return this.#resolver.resolve(doc === undefined
            ? query.clone({ flags: { ...flags, required: true } })
            : query.clone({ doc }));
        });
      }
      case 'updateMany': {
        return this.#resolver.withTransaction((txn) => {
          return this.#find(query, txn).then((docs) => {
            return settleMany(docs.map(doc => txn.match(this.#model.name).flags(flags).id(doc.id).save(input)));
          });
        });
      }
      case 'pushOne': {
        return this.#get(query).then((doc) => {
          const [key] = Object.keys(input);
          const $query = Object.assign(query.toObject(), { doc });
          const args = { query: $query, resolver: this.#resolver, context: this.#context };
          const values = get(this.#model.transformers.create.transform(input, args), key);
          const $input = { [key]: (get(doc, key) || []).concat(...values) };
          return this.#resolver.match(this.#model.name).flags(flags).id(doc.id).save($input);
        });
      }
      case 'pushMany': {
        const [[key, values]] = Object.entries(input);
        return this.#resolver.withTransaction((txn) => {
          return this.#find(query, txn).then((docs) => {
            return settleMany(docs.map(doc => txn.match(this.#model.name).flags(flags).id(doc.id).push(key, values)));
          });
        });
      }
      case 'pullOne': {
        return this.#get(query).then((doc) => {
          const [[path, inputs]] = Object.entries(input);
          const [key] = path.split('.');
          const $doc = Util.pathmap(path, doc, (mixed) => { // Pathmap because nested arrays
            if (mixed == null) return mixed;
            return mixed.filter(el => inputs.every(v => `${v}` !== `${el}`));
          });
          return this.#resolver.match(this.#model.name).flags(flags).id(doc.id).save({ [key]: get($doc, key) });
        });
      }
      case 'pullMany': {
        const [[key, values]] = Object.entries(input);
        return this.#resolver.withTransaction((txn) => {
          return this.#find(query, txn).then((docs) => {
            return settleMany(docs.map(doc => txn.match(this.#model.name).flags(flags).id(doc.id).pull(key, values)));
          });
        });
      }
      case 'spliceOne': {
        return this.#get(query).then((doc) => {
          const [[path, [find, replace]]] = Object.entries(input);
          const [key] = path.split('.');
          const $doc = Util.pathmap(path, doc, (mixed) => { // Pathmap because nested arrays
            if (mixed == null) return mixed;
            if (Array.isArray(mixed)) return mixed.map(el => (`${el}` === `${find}` ? replace : el));
            if (`${mixed}` === `${find}`) return replace;
            return mixed;
          });
          return this.#resolver.match(this.#model.name).flags(flags).id(doc.id).save({ [key]: get($doc, key) });
        });
      }
      case 'spliceMany': {
        const [[key, values]] = Object.entries(input);
        return this.#resolver.withTransaction((txn) => {
          return this.#find(query, txn).then((docs) => {
            return settleMany(docs.map(doc => txn.match(this.#model.name).flags(flags).id(doc.id).splice(key, ...values)));
          });
        });
      }
      case 'deleteOne': {
        return this.#resolveReferentialIntegrity(query);
      }
      case 'deleteMany': {
        return this.#resolver.withTransaction((txn) => {
          return this.#find(query, txn).then((docs) => {
            return settleMany(docs.map(doc => txn.match(this.#model.name).flags(flags).id(doc.id).delete()));
          });
        });
      }
      default: {
        return Promise.reject(new Error(`Unknown operation "${op}"`));
      }
    }
  }

  #get(query, resolver = this.#resolver) {
    return resolver.match(this.#model.name).id(query.toObject().id).one({ required: true });
  }

  #find(query, resolver = this.#resolver) {
    return resolver.resolve(query.clone({ op: 'findMany', key: `find${this.#model.name}`, crud: 'read', isMutation: false }));
  }

  // The sole entry point for deleteOne — the pre-image read, the cascade walk, AND the actual
  // delete are all part of the same wrapped `run`, so there's no separate dance at the call site
  // to keep in sync with the "does this delete need transactional demarcation" decision.
  //
  // RI cascades are self-contained: autograph itself is both the opener and the definitive closer
  // of this unit of work (the same principle the operation scope satisfies in-band at the GraphQL
  // layer — see OperationScope.js), so it's
  // safe to unconditionally wrap them. `this.#resolver.withTransaction`
  // is the exact same public method a manual caller uses — always `{ isolated: true }` (its
  // default), since this can be triggered from code sharing a resolver instance with concurrent
  // siblings (e.g. two postMutation hooks on the same event) and must never mutate that shared
  // instance's own scope.
  #resolveReferentialIntegrity(query) {
    // Sequential, not Promise.allSettled+settleMany like the *Many fan-outs above — each step
    // targets a different model/rule, order isn't independent the way batch elements are, so it
    // stays a walk. But it still can't use a plain stop-at-first-rejection chain: a
    // PostOperationError from an early step (its data is complete, only its presenter-phase
    // preResponse/postResponse hook failed) must not abort the walk — doing so would leave LATER
    // cascade steps never even attempted, yet still committed as if the cascade were complete
    // (see Resolver#withTransaction's commit-on-PostOperationError). So: catch a
    // PostOperationError per step, stash it, keep walking; a real failure — including a
    // participant (postMutation) failure, which arrives unwrapped — still stops the walk
    // immediately (rollback is correct there). Aggregated at the end, same as settleMany.
    const run = async (txn) => {
      // Pre-image read INSIDE the wrapped scope (eager — this read binds the session), so the
      // cascade's where clauses, the restrict counts, and the delete itself all see one
      // consistent view. Reading it before/outside the transaction left a window where the doc
      // could change between the read and the cascade computed from it.
      const doc = await this.#get(query, txn);
      const postFailures = [];

      for (const { model, field, isArray, path } of this.#model.referentialIntegrity) {
        const { onDelete, fkField } = field;
        const id = doc[fkField];
        const $path = path.join('.');
        const where = field.isVirtual ? { [field.model.pkField]: get(doc, field.linkBy) } : { [$path]: id };

        try {
          // Sequential by necessity — each cascade step must see the effects of the ones before
          // it, and the walk must fully finish (not bail on the first PostOperationError) before
          // the caller can decide commit vs. rollback. See the comment on `run` above.
          switch (onDelete) {
            case 'cascade': await (isArray ? txn.match(model).where(where).pull($path, id) : txn.match(model).where(where).remove()); break; // eslint-disable-line no-await-in-loop
            case 'nullify': await (isArray ? txn.match(model).where(where).splice($path, id, null) : txn.match(model).where(where).save({ [$path]: null })); break; // eslint-disable-line no-await-in-loop
            case 'restrict': {
              const count = await txn.match(model).where(where).count(); // eslint-disable-line no-await-in-loop
              if (count) throw new Error('Restricted');
              break;
            }
            default: throw new Error(`Unknown onDelete operator: '${onDelete}'`);
          }
        } catch (e) {
          if (!(e instanceof PostOperationError)) throw e;
          postFailures.push(e.data);
        }
      }

      let result;
      try {
        result = await txn.resolve(query.clone({ doc })).then(() => doc);
      } catch (e) {
        if (!(e instanceof PostOperationError)) throw e;
        postFailures.push(e.data);
        result = e.result;
      }

      if (postFailures.length === 1) throw new PostOperationError(postFailures[0], result);
      if (postFailures.length > 1) throw new PostOperationError(new AggregateError(postFailures), result);
      return result;
    };

    // Only pay for a transaction when there's an actual cascade to protect — a model with no
    // @field(onDelete:) rules deletes exactly one document, already atomic on its own.
    if (this.#model.referentialIntegrity.length) return this.#resolver.withTransaction(run);
    // No cascades: a single-document delete — elision-eligible through the same slot.
    return this.#model.preImage(query, this.#resolver).then((doc) => {
      return this.#resolver.resolve(doc === undefined
        ? query.clone({ flags: { ...query.toObject().flags, required: true } })
        : query.clone({ doc }));
    });
  }
};
