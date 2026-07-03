const Util = require('@coderich/util');
const { MongoClient, ObjectId } = require('mongodb');

module.exports = class MongoDriver {
  #config;
  #mongoClient;
  #connection;

  constructor(config = {}) {
    this.#config = config;
    this.#config.query = config.query || {};
    this.#mongoClient = new MongoClient(config.uri, config.options);
    this.#connection = this.#mongoClient.connect();
  }

  prepare(query) {
    const options = { ...this.#config.query, ...query.options };
    const plan = { op: query.op, model: query.model, options };

    switch (query.op) {
      case 'findOne':
      case 'findMany':
        plan.$aggregate = MongoDriver.aggregateQuery(query);
        break;
      case 'count':
        plan.$aggregate = MongoDriver.aggregateQuery(query, true);
        break;
      case 'createOne':
        plan.doc = query.input;
        delete plan.options.collation;
        break;
      case 'updateOne':
        plan.options.returnDocument = 'after';
        plan.where = query.where;
        plan.update = query.isSaveNative ? query.input : { $set: query.input };
        break;
      case 'deleteOne':
      case 'deleteMany':
        plan.where = query.where;
        break;
      default:
        break;
    }

    return plan;
  }

  execute(plan) {
    return Util.promiseRetry(() => this[plan.op](plan), 5, 5, e => e.hasErrorLabel && e.hasErrorLabel('TransientTransactionError'));
  }

  findOne(plan) {
    return this.collection(plan.model).aggregate(plan.$aggregate, plan.options).then(cursor => cursor.next());
  }

  findMany(plan) {
    return this.collection(plan.model).aggregate(plan.$aggregate, plan.options).then(cursor => cursor.toArray());
  }

  count(plan) {
    return this.collection(plan.model).aggregate(plan.$aggregate, plan.options).then((cursor) => {
      return cursor.next().then(doc => (doc ? doc.count : 0));
    });
  }

  createOne(plan) {
    return this.collection(plan.model).insertOne(plan.doc, plan.options).then(result => ({ ...plan.doc, _id: result.insertedId }));
  }

  updateOne(plan) {
    return this.collection(plan.model).findOneAndUpdate(plan.where, plan.update, plan.options);
  }

  deleteOne(plan) {
    return this.collection(plan.model).deleteOne(plan.where, plan.options);
  }

  deleteMany(plan) {
    return this.collection(plan.model).deleteMany(plan.where, plan.options);
  }

  collection(name) {
    return new Proxy(this.#connection, {
      get(target, method) {
        return (...args) => {
          return target.then(client => client.db().collection(name)[method](...args));
        };
      },
    });
  }

  disconnect() {
    return this.#connection.then(client => client.close());
  }

  driver(name) {
    return this.collection(name);
  }

  // MongoDB has no savepoint primitive — a session supports exactly one active transaction, so
  // there is no such thing as a "child" session. When offered a parent handle ({ session, commit,
  // rollback }), we simply hand it back unchanged: TransactionScope reacts to that identity
  // (handle === parentHandle) to know this is a coupled/shared-fate relationship, not a real
  // nested transaction. Never invoked with a parent unless something ambient already exists
  // (the operation scope, a manual transaction, or an RI/*Many wrap) — see TransactionScope#getHandle.
  transaction(parentHandle) {
    if (parentHandle) return Promise.resolve(parentHandle);

    return this.#connection.then((client) => {
      let closed = false;
      const session = client.startSession(this.#config.session);
      session.startTransaction(this.#config.transaction);

      // Because we allow queries in parallel we want to prevent calling this more than once
      const close = (operator) => {
        if (!closed) return (closed = true && session[operator]().finally(() => session.endSession()));
        return Promise.resolve();
      };

      return Object.defineProperties({}, {
        session: { value: session, enumerable: true },
        commit: { value: () => close('commitTransaction') },
        rollback: { value: () => close('abortTransaction') },
      });
    });
  }

  static ObjectId = ObjectId;

  static aggregateJoin(query, join) {
    const { as, to: from, on: foreignField, from: localField, where: $match } = join;
    const varName = `${as}_${join.from.replaceAll('.', '_')}`;
    const $let = { [varName]: `$${localField}` };
    const op = join.isArray ? '$in' : '$eq';
    // When the local field is an array, defend against parent docs that are missing it (or
    // have null). Mongo's $in needs an array as the second operand; "missing"/null throws
    // "$in requires an array as a second argument, found: missing" during aggregation.
    const valueExpr = join.isArray ? { $ifNull: [`$$${varName}`, []] } : `$$${varName}`;
    $match.$expr = { [op]: [`$${foreignField}`, valueExpr] };
    const pipeline = [{ $match }];
    return [
      {
        $lookup: {
          from,
          let: $let,
          pipeline,
          as,
        },
      },
      {
        $unwind: `$${as}`,
      },
    ];
  }

  static aggregateJoins(query, joins = []) {
    return [
      ...MongoDriver.#buildJoinPipeline(query, joins),
      { $group: { _id: '$_id', data: { $first: '$$ROOT' } } },
      { $replaceRoot: { newRoot: '$data' } },
    ];
  }

  static #buildJoinPipeline(query, joins) {
    return joins.flatMap((join) => {
      const $agg = MongoDriver.aggregateJoin(query, join);
      if (join.children?.length) $agg[0].$lookup.pipeline.push(...MongoDriver.#buildJoinPipeline(query, join.children));
      return $agg;
    });
  }

  static convertFieldsForSort(sort) {
    return Object.entries(Util.flatten(sort, false)).reduce((prev, [key, value]) => {
      return Object.assign(prev, { [key]: value === 'asc' ? 1 : -1 });
    }, {});
  }

  static convertFieldsForRegex($schema, model, where, forceArray) {
    return Object.entries(where).reduce((prev, [key, mixed]) => {
      const field = $schema(`${model}.${key}`);
      const [value] = Object.values(Util.flatten({ mixed }, { safe: true }));

      if (Util.ensureArray(value).some(el => el instanceof RegExp)) {
        const conversion = forceArray || field.isArray ? { $map: { input: `$${key}`, as: 'el', in: { $toString: '$$el' } } } : { $toString: `$${key}` };
        Object.assign(prev, { [key]: conversion });
      }

      return prev;
    }, {});
  }

  static aggregateQuery(query, count = false) {
    const { model, select, where, sort = {}, skip, limit, joins, after, before, first, isWhereNative, isSortNative } = query;
    const $aggregate = [{ $match: where }];
    const $addFields = isWhereNative ? {} : MongoDriver.convertFieldsForRegex(query.$schema, model, where);
    const $sort = isSortNative ? sort : MongoDriver.convertFieldsForSort(sort);

    // Regex addFields
    if (Object.keys($addFields).length) $aggregate.unshift({ $addFields });

    // Joins
    if (joins?.length) $aggregate.push(...MongoDriver.aggregateJoins(query, joins));

    if (count) {
      $aggregate.push({ $count: 'count' });
    } else {
      // Sort, Skip, Limit documents
      if ($sort && Object.keys($sort).length) $aggregate.push({ $sort });
      if (skip) $aggregate.push({ $skip: skip });
      if (limit) $aggregate.push({ $limit: limit });

      // Pagination
      if (after) $aggregate.push({ $match: { $or: Object.entries(after).reduce((prev, [key, value]) => prev.concat({ [key]: { [$sort[key] === 1 ? '$gte' : '$lte']: value } }), []) } });
      if (before) $aggregate.push({ $match: { $or: Object.entries(before).reduce((prev, [key, value]) => prev.concat({ [key]: { [$sort[key] === 1 ? '$lte' : '$gte']: value } }), []) } });
      if (first) $aggregate.push({ $limit: first });

      // Field projections
      if (select?.length) $aggregate.push({ $project: select.reduce((prev, key) => Object.assign(prev, { [key]: 1 }), {}) });
    }

    return $aggregate;
  }
};
