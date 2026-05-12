const { inspect } = require('node:util');
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

  resolve(query) {
    query.options = { ...this.#config.query, ...query.options };
    if (!query.isNative) query.where = MongoDriver.normalizeWhereClause(query.where);
    if (query.flags.debug) console.log(inspect(query, { showHidden: false, colors: true, depth: 3 }));
    return Util.promiseRetry(() => this[query.op](query), 5, 5, e => e.hasErrorLabel && e.hasErrorLabel('TransientTransactionError'));
  }

  findOne(query) {
    const $aggregate = MongoDriver.aggregateQuery(query);
    return this.collection(query.model).aggregate($aggregate, query.options).then(cursor => cursor.next());
  }

  findMany(query) {
    const $aggregate = MongoDriver.aggregateQuery(query);
    return this.collection(query.model).aggregate($aggregate, query.options).then(cursor => cursor.toArray());
  }

  count(query) {
    const $aggregate = MongoDriver.aggregateQuery(query, true);
    return this.collection(query.model).aggregate($aggregate, query.options).then((cursor) => {
      return cursor.next().then((doc) => {
        return doc ? doc.count : 0;
      });
    });
  }

  createOne(query) {
    delete query.options.collation;
    return this.collection(query.model).insertOne(query.input, query.options).then(result => ({ ...query.input, _id: result.insertedId }));
  }

  updateOne(query) {
    query.options.returnDocument = 'after';
    const $update = { $set: query.input };
    return this.collection(query.model).findOneAndUpdate(query.where, $update, query.options);
  }

  deleteOne(query) {
    return this.collection(query.model).deleteOne(query.where, query.options);
  }

  deleteMany(query) {
    return this.collection(query.model).deleteMany(query.where, query.options);
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

  transaction() {
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

  static normalizeWhereClause(where) {
    return Object.entries(Util.flatten(where, { safe: true })).reduce((prev, [key, value]) => {
      if (Array.isArray(value)) return Object.assign(prev, { [key]: { $in: value } });
      return Object.assign(prev, { [key]: value });
    }, {});
  }

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
    const { model, select, where, sort = {}, skip, limit, joins, after, before, first, isNative } = query;
    const $aggregate = [{ $match: where }];
    const $addFields = isNative ? {} : MongoDriver.convertFieldsForRegex(query.$schema, model, where);
    const $sort = MongoDriver.convertFieldsForSort(sort);

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

    if (query.flags.debug) console.log(inspect($aggregate, { depth: null, showHidden: false, colors: true }));

    return $aggregate;
  }
};
