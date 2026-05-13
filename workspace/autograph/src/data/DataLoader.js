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
     * Smart batching.
     *
     * Given N queries arriving in the same DataLoader tick, find the largest subsets that can be
     * merged into single Mongo round-trips. A subset is mergeable when every query in it has:
     *   - the same structural shape (op, sort, limit, skip, paging, select)
     *   - where clauses that are identical EXCEPT for one key's value (the fanout key)
     * Such a subset collapses into one findMany with `where: { ...shared, [fanoutKey]: $in }`.
     *
     * This generalizes the previous "single-key where" heuristic which broke as soon as any
     * preQuery hook added a scoping field (e.g., workspace) to the where clause: every per-parent
     * findMany then fell through to a separate driver call.
     */
    const driverQueries = queries.map((query, i) => ({ query, $query: query.toDriver().toObject(), i }));

    // Bucket by structural fingerprint — non-where dimensions that must all match for a merge.
    const structurals = new Map();
    driverQueries.forEach((dq) => {
      const fp = Loader.#structuralFingerprint(dq.$query);
      if (!structurals.has(fp)) structurals.set(fp, []);
      structurals.get(fp).push(dq);
    });

    const work = [];
    structurals.forEach((group) => {
      if (group.length === 1) {
        work.push(Loader.#runSingle(this.#model.source.client, group[0]));
        return;
      }

      const clusters = Loader.#findMergeClusters(group);
      clusters.forEach((cluster) => {
        if (cluster.batchKey == null || cluster.batches.length === 1) {
          cluster.batches.forEach(b => work.push(Loader.#runSingle(this.#model.source.client, b)));
        } else {
          work.push(Loader.#runMerged(this.#model.source.client, cluster));
        }
      });
    });

    return Promise.all(work).then((results) => {
      return results.flat().sort((a, b) => a.i - b.i).map(({ query, $query, data }) => {
        if (data == null) return null; // Explicit return null;
        if ($query.isCursorPaging && Array.isArray(data)) data = Loader.#paginateResults(data, query.toObject());
        return this.#resolver.toResultSet(this.#model, data);
      });
    });
  }

  // Stable, deterministic serialization for clustering. Sorts object keys recursively so that
  // two semantically-equal objects produce the same string regardless of insertion order.
  // Handles RegExp, Date, and ObjectId-like things (anything with a toHexString) reliably.
  static #canonicalize(val) {
    if (val == null) return val;
    if (val instanceof RegExp) return ['__re__', val.toString()];
    if (val instanceof Date) return ['__d__', val.toISOString()];
    if (typeof val.toHexString === 'function') return ['__oid__', val.toHexString()];
    if (Array.isArray(val)) return val.map(Loader.#canonicalize);
    if (typeof val !== 'object') return val;
    const sorted = {};
    Object.keys(val).sort().forEach((k) => { sorted[k] = Loader.#canonicalize(val[k]); });
    return sorted;
  }

  // Everything except `where` values — what must match for two queries to be candidate-merge.
  // Two queries with the same structural fingerprint compete in the same merge bucket; their
  // where clauses are then examined to find a fanout key.
  static #structuralFingerprint($query) {
    return JSON.stringify(Loader.#canonicalize({
      op: $query.op,
      model: $query.model,
      sort: $query.sort,
      select: $query.select,
      skip: $query.skip,
      limit: $query.limit,
      first: $query.first,
      last: $query.last,
      before: $query.before,
      after: $query.after,
      whereKeys: Object.keys($query.where || {}).sort(),
    }));
  }

  // Queries that have paging args (limit, skip, first/last, before/after) cannot safely merge —
  // a merged `findMany ... limit: 10` returns 10 docs total, not 10 per batch. These must run
  // as individual driver calls.
  static #isMergeable($query) {
    return !$query.limit && !$query.skip && !$query.first && !$query.last && !$query.before && !$query.after;
  }

  // For each batch in a structural group, find clusters that can merge: queries whose where
  // clauses are identical except for the value at exactly one key. That key becomes the fanout.
  //
  // Algorithm: for each query, for each where key, compute a leave-one-out signature. Queries
  // with the same (key, loo) compete to merge on that key. Greedy assignment — largest cluster
  // wins; remaining queries fall to smaller clusters or singletons.
  static #findMergeClusters(group) {
    if (group.length < 2) return [{ batchKey: null, batches: group }];

    // Build a candidate index: signature → { batchKey, batches }. Paging-laden queries are
    // excluded from candidate clusters and fall to singletons below.
    const candidates = new Map();
    group.forEach((b) => {
      if (!Loader.#isMergeable(b.$query)) return;
      const where = b.$query.where || {};
      const keys = Object.keys(where);
      if (keys.length === 0) return; // nothing to vary on
      keys.forEach((key) => {
        const others = {};
        keys.forEach((k) => { if (k !== key) others[k] = where[k]; });
        const sig = `${key}|${JSON.stringify(Loader.#canonicalize(others))}`;
        if (!candidates.has(sig)) candidates.set(sig, { batchKey: key, batches: [] });
        candidates.get(sig).batches.push(b);
      });
    });

    // Greedy: assign each batch to its largest candidate cluster
    const sorted = Array.from(candidates.values()).sort((a, b) => b.batches.length - a.batches.length);
    const assigned = new Set();
    const clusters = [];
    sorted.forEach((cand) => {
      const fresh = cand.batches.filter(b => !assigned.has(b));
      if (fresh.length < 2) return;
      clusters.push({ batchKey: cand.batchKey, batches: fresh });
      fresh.forEach(b => assigned.add(b));
    });

    // Whatever didn't make a cluster (including paging queries) runs as a singleton
    group.forEach((b) => {
      if (!assigned.has(b)) clusters.push({ batchKey: null, batches: [b] });
    });

    return clusters;
  }

  static #runSingle(client, batch) {
    return client.resolve(batch.$query).then(data => [{ data, ...batch }]);
  }

  // Execute one merged query for a cluster, then distribute results back to each original batch
  // based on the value at the cluster's batchKey. Mirrors the distribution logic of the prior
  // implementation (RegExp values match across docsByKey; findOne returns first match).
  //
  // Large `$in` arrays are split into parallel chunks (CHUNK_SIZE values per sub-query). Each
  // chunk fits comfortably in one Mongo cursor batch, exercises any usable index efficiently,
  // and the chunks run concurrently — preserving the round-trip-count savings while avoiding
  // a single oversized query that pages back over many RTTs on a high-latency connection.
  static #runMerged(client, cluster) {
    const CHUNK_SIZE = 500;
    const { batchKey, batches } = cluster;
    const flatValues = (b) => {
      const v = Util.flatten(b.$query.where, { safe: true })[batchKey];
      return Util.ensureArray(v);
    };
    const batchValues = batches.map(b => Loader.#dedup(flatValues(b)));
    const allValues = Loader.#dedup(batchValues.flat());

    // Below the threshold, individual driver calls are cheaper than the merge overhead.
    if (allValues.length < 3) {
      return Promise.all(batches.map(b => client.resolve(b.$query).then(data => ({ data, ...b }))));
    }

    // Preserve every where field — only the batchKey is widened to $in across all values.
    const sharedWhere = { ...batches[0].$query.where };
    delete sharedWhere[batchKey];

    // Split the values into chunks of CHUNK_SIZE; one Mongo query per chunk, all in parallel.
    const chunks = [];
    for (let i = 0; i < allValues.length; i += CHUNK_SIZE) chunks.push(allValues.slice(i, i + CHUNK_SIZE));
    const chunkQueries = chunks.map(values => ({ ...batches[0].$query, op: 'findMany', where: { ...sharedWhere, [batchKey]: values } }));

    return Promise.all(chunkQueries.map(q => client.resolve(q))).then((docsByChunk) => {
      // Dedupe across chunks by id. When the fanout key is an array-valued field (e.g.,
      // NetworkPlace.ancestors), a doc whose array spans multiple chunks is returned by each.
      // Set-based dedupe later compares by reference and can't collapse those JS-distinct
      // instances of the same logical doc — without this, the GraphQL response carries the
      // duplicate. Note: the wire-level duplicate transfer is still happening; this is a
      // best-effort guard, and the more complete fix is to skip chunking entirely for
      // array-valued fanout keys.
      const seen = new Set();
      const docs = [];
      docsByChunk.flat().forEach((doc) => {
        const rawId = doc?._id ?? doc?.id;
        const id = rawId == null ? null : `${rawId}`;
        if (id != null && seen.has(id)) return;
        if (id != null) seen.add(id);
        docs.push(doc);
      });
      const docsByKey = new Map();
      docs.forEach((doc) => {
        Util.pathmap(batchKey, doc, (value) => {
          Util.ensureArray(value).forEach((v) => {
            const k = `${v}`;
            if (!docsByKey.has(k)) docsByKey.set(k, []);
            docsByKey.get(k).push(doc);
          });
          return value;
        });
      });

      return batches.map((batch, idx) => {
        const matches = Array.from(new Set(batchValues[idx].flatMap((v) => {
          if (v instanceof RegExp) {
            const result = [];
            docsByKey.forEach((d, k) => { if (v.test(k)) result.push(...d); });
            return result;
          }
          return docsByKey.get(`${v}`) || [];
        })));
        // Per-op shape: findOne returns one doc, count returns the count, findMany returns the array.
        // The merge widened op to findMany on the wire; we project back to each batch's original op here.
        let data;
        switch (batch.$query.op) {
          case 'findOne': [data] = matches; break;
          case 'count': data = matches.length; break;
          default: data = matches; break;
        }
        return { data, ...batch };
      });
    });
  }

  // Deduplicate an array of values that may contain RegExp objects.
  // new Set() compares by reference, so two RegExp literals with identical patterns
  // are treated as distinct. Using toString() as the Map key handles this correctly
  // while preserving the actual RegExp instance as the value.
  static #dedup(arr) {
    const seen = new Map();
    arr.forEach(v => seen.set(v instanceof RegExp ? v.toString() : v, v));
    return Array.from(seen.values());
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
