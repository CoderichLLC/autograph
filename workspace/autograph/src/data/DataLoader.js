const get = require('lodash.get');
const Util = require('@coderich/util');
const DataLoader = require('dataloader');

module.exports = class Loader {
  #model;
  #loader;
  #resolver;

  constructor(model, resolver) {
    this.#model = model;
    this.#resolver = resolver;
    this.#model.loader.cacheKeyFn ??= query => query.toCacheKey();
    this.#loader = new DataLoader(keys => this.#resolve(keys), this.#model.loader);
  }

  clearAll() {
    return this.#loader.clearAll();
  }

  resolve(query) {
    return this.#loader.load(query);
  }

  #resolve(queries) {
    /**
     * Batch queries can save resources and network round-trip latency. However, we have to be careful to
     * preserve the order and adhere to the DataLoader API. This step simply creates a map of batch
     * queries to run; saving the order ("i") along with useful query information
     */
    const batchesByKey = queries.reduce((prev, query, i) => {
      const $query = query.toDriver().toObject();
      const key = $query.batch ?? '__default__';
      let [values] = key === '__default__' ? [] : Object.values(Util.flatten($query.where, { safe: true }));
      values = Array.from(new Set(Util.ensureArray(values)));
      prev[key] = prev[key] || [];
      prev[key].push({ query, $query, values, i });
      return prev;
    }, {});

    return Promise.all(Object.entries(batchesByKey).map(([key, batches]) => {
      switch (key) {
        case '__default__': {
          return batches.map(batch => this.#model.source.client.resolve(batch.$query).then(data => ({ data, ...batch })));
        }
        default: {
          // Collect all the values for the where clause
          const values = Array.from(new Set(batches.map(batch => batch.values).flat()));
          const $query = { ...batches[0].$query, op: 'findMany', where: { [key]: values } };

          if (values.length < 3) {
            return batches.map(batch => this.#model.source.client.resolve(batch.$query).then(data => ({ data, ...batch })));
          }

          // Now we perform 1 query, instead of many smaller ones
          return this.#model.source.client.resolve($query).then((docs) => {
            const docsByKey = new Map();

            docs.forEach((doc) => {
              Util.pathmap(key, doc, (value) => {
                Util.ensureArray(value).forEach((v) => {
                  const k = `${v}`;
                  if (!docsByKey.has(k)) docsByKey.set(k, []);
                  docsByKey.get(k).push(doc);
                });
                return value;
              });
            });

            return batches.map((batch) => {
              const matches = Array.from(new Set(batch.values.flatMap((v) => {
                if (v instanceof RegExp) {
                  const result = [];
                  docsByKey.forEach((d, k) => { if (v.test(k)) result.push(...d); });
                  return result;
                }
                return docsByKey.get(`${v}`) || [];
              })));
              const data = batch.$query.op === 'findOne' ? matches[0] : matches;
              return { data, ...batch };
            });
          });
        }
      }
    }).flat()).then((results) => {
      return results.flat().sort((a, b) => a.i - b.i).map(({ query, $query, data }) => {
        if (data == null) return null; // Explicit return null;
        if ($query.isCursorPaging && Array.isArray(data)) data = Loader.#paginateResults(data, query.toObject());
        return this.#resolver.toResultSet(this.#model, data);
      });
    });

    // return Promise.all(queries.map((query, i) => {
    //   const dquery = query.toDriver();
    //   const $query = dquery.toObject();

    //   return this.#model.source.client.resolve($query).then((data) => {
    //     if (data == null) return null; // Explicit return null;
    //     if ($query.isCursorPaging && Array.isArray(data)) data = Loader.#paginateResults(data, query.toObject());
    //     return this.#resolver.toResultSet(this.#model, data);
    //   });
    // }));
  }

  static #paginateResults(rs, query) {
    let hasNextPage = false;
    let hasPreviousPage = false;
    const { first, after, last, before, sort = {} } = query;
    const sortPaths = Object.keys(Util.flatten(sort, { safe: true }));
    const limiter = first || last;

    // Add $cursor data (but only if sort is defined!)
    if (sortPaths.length) {
      Util.map(rs, (doc) => {
        const sortValues = sortPaths.reduce((prev, path) => Object.assign(prev, { [path]: get(doc, path) }), {});
        Object.defineProperty(doc, '$cursor', { value: Buffer.from(JSON.stringify(sortValues)).toString('base64') });
      });
    }

    // First try to take off the "bookends" ($gte | $lte)
    if (rs.length && rs[0].$cursor === after) {
      rs.shift();
      hasPreviousPage = true;
    }

    if (rs.length && rs[rs.length - 1].$cursor === before) {
      rs.pop();
      hasNextPage = true;
    }

    // Next, remove any overage
    const overage = rs.length - (limiter - 2);

    if (overage > 0) {
      if (first) {
        rs.splice(-overage);
        hasNextPage = true;
      } else if (last) {
        rs.splice(0, overage);
        hasPreviousPage = true;
      } else {
        rs.splice(-overage);
        hasNextPage = true;
      }
    }

    // Add $pageInfo
    return Object.defineProperty(rs, '$pageInfo', {
      value: {
        startCursor: get(rs, '0.$cursor', ''),
        endCursor: get(rs, `${rs.length - 1}.$cursor`, ''),
        hasPreviousPage,
        hasNextPage,
      },
    });
  }
};
