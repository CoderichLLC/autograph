const get = require('lodash.get');
const Util = require('@coderich/util');

const CHUNK_SIZE = 500;

/**
 * QueryPlanner — cross-source join resolution.
 *
 * When a query spans multiple data sources (e.g. Book on Postgres, Person on MongoDB),
 * a driver-level join is impossible. QueryPlanner intercepts those queries and resolves
 * them transparently through a two-phase pipeline:
 *
 *   Phase 1 (pre):  cross-source WHERE paths → pre-query the foreign source → inject $in
 *   Phase 2 (post): cross-source SORT paths  → batch-fetch sort values    → in-memory sort + paginate
 *
 * Same-source WHERE/SORT/limit/skip are passed through to the driver unchanged.
 * Drivers never see any cross-source artefacts.
 */
module.exports = class QueryPlanner {
  #schema;
  #resolver;

  constructor(schema, resolver) {
    this.#schema = schema;
    this.#resolver = resolver;
  }

  /**
   * Main entry point called by Resolver for every read operation.
   *
   * @param {string}   modelName    - The root model name
   * @param {Query}    tquery       - The transformed (but not yet driver-finalised) Query instance
   * @param {Function} executeDriver - Callback: (Query) → Promise<results> — runs the driver query
   */
  async resolve(modelName, tquery, executeDriver) {
    const plan = this.#analyze(modelName, tquery);

    if (!plan.hasCrossSource) return executeDriver(tquery);

    // Phase 1: pre-query any cross-source WHERE constraints and rewrite the query
    const rewrittenQuery = await this.#preResolve(plan, tquery);

    if (rewrittenQuery === null) {
      // A pre-query returned empty — no primary results are possible
      const { op } = plan;
      if (op === 'count') return 0;
      if (op === 'findMany') return [];
      return null;
    }

    // Driver executes the clean, single-source query
    const results = await executeDriver(rewrittenQuery);

    // Phase 2: post-process when cross-source sort was requested
    if (plan.crossSourceSort.length) return this.#postResolve(plan, results);

    return results;
  }

  // ---------------------------------------------------------------------------
  // Analysis
  // ---------------------------------------------------------------------------

  /**
   * Walk the raw query's where and sort to identify cross-source paths.
   * Returns a plan that drives both pre- and post-resolution.
   */
  #analyze(modelName, tquery) {
    const model = this.#schema.models[modelName];
    const rootSource = model.source;
    const rawQuery = tquery.toObject();
    const { where = {}, sort = {}, op, limit, skip, first, last, before, after, isCursorPaging } = rawQuery;

    const flatWhere = Util.flatten(where, { safe: true });
    const flatSort = Util.flatten(sort, { safe: true });

    // WHERE: group cross-source FK sub-path conditions by the FK field name
    const whereGroupsByField = {};
    const sameSourceWhere = {};

    for (const [path, value] of Object.entries(flatWhere)) {
      const [fieldName, ...subParts] = path.split('.');
      const field = model.fields[fieldName];

      // Only pre-query when filtering BY a property of the related model (sub-path present)
      if (!field?.isFKReference || !subParts.length || !field.model?.source || field.model.source === rootSource) {
        sameSourceWhere[path] = value;
        continue;
      }

      if (!whereGroupsByField[fieldName]) {
        whereGroupsByField[fieldName] = {
          fieldName,
          field,
          conditions: {},
          // Where to inject the $in result on THIS model's where clause
          localInjectField: field.isVirtual ? model.pkField : fieldName,
          // Which field to SELECT from the foreign model (gives us the values to inject)
          foreignSelectField: field.isVirtual ? field.linkBy : field.fkField,
          foreignModelName: field.model.name,
        };
      }

      whereGroupsByField[fieldName].conditions[subParts.join('.')] = value;
    }

    const crossSourceWhere = Object.values(whereGroupsByField);

    // SORT: process in original insertion order so multi-key sort priority is preserved.
    // If ANY key is cross-source, ALL sort + ALL pagination is stripped from the driver
    // query and applied in-memory after augmenting results with foreign sort values.
    const sortSpec = []; // full sort spec in original priority order, for in-memory sort
    const sameSourceSort = {};

    for (const [path, direction] of Object.entries(flatSort)) {
      const [fieldName, ...subParts] = path.split('.');
      const field = model.fields[fieldName];
      const dir = String(direction || 'asc').toLowerCase();
      const isCrossSource = Boolean(
        field?.isFKReference && subParts.length && field.model?.source && field.model.source !== rootSource,
      );

      sortSpec.push({
        path,           // original path, e.g. 'author.name'
        dir,
        isCrossSource,
        augmentKey: isCrossSource ? `__xsort_${fieldName}` : null,
        // Cross-source-specific fields (null for same-source)
        fieldName: isCrossSource ? fieldName : null,
        field: isCrossSource ? field : null,
        sortPath: isCrossSource ? subParts.join('.') : null,   // sub-path within foreign model
        localFKField: isCrossSource ? (field.isVirtual ? model.pkField : fieldName) : null,
        foreignLookupField: isCrossSource ? (field.isVirtual ? field.linkBy : field.fkField) : null,
        foreignModelName: isCrossSource ? field.model.name : null,
      });

      if (!isCrossSource) sameSourceSort[path] = direction;
    }

    const crossSourceSort = sortSpec.filter(s => s.isCrossSource);

    return {
      hasCrossSource: crossSourceWhere.length > 0 || crossSourceSort.length > 0,
      model,
      op,
      crossSourceWhere,
      crossSourceSort,
      sortSpec,
      sameSourceWhere,
      sameSourceSort,
      originalPagination: { op, limit, skip, first, last, before, after, isCursorPaging },
    };
  }

  // ---------------------------------------------------------------------------
  // Phase 1: pre-resolution (cross-source WHERE)
  // ---------------------------------------------------------------------------

  /**
   * Execute pre-queries for cross-source WHERE groups, rewrite the query with injected
   * $in constraints, and strip sort/pagination from the driver when cross-source sort is needed.
   * Returns null if any pre-query produces no results (guaranteed empty primary result).
   */
  async #preResolve(plan, tquery) {
    const { crossSourceWhere, crossSourceSort, sameSourceWhere, sameSourceSort, op } = plan;
    const rawQuery = tquery.toObject();

    // Start from the same-source where paths only
    const rewrittenWhere = Util.unflatten(sameSourceWhere, { safe: true });

    for (const { field, conditions, localInjectField, foreignSelectField, foreignModelName } of crossSourceWhere) {
      const foreignDocs = await this.#resolver.match(foreignModelName)
        .where(conditions)
        .select([foreignSelectField])
        .many();

      const ids = foreignDocs.map(d => d[foreignSelectField]).flat().filter(Boolean);
      if (!ids.length) return null; // short-circuit — no primary results possible

      // Inject as array; Query.#finalize() normalises arrays to { $in: [...] }
      rewrittenWhere[localInjectField] = ids;
    }

    if (!crossSourceSort.length) {
      // No cross-source sort — only the WHERE needed rewriting; pass sort/pagination through
      return tquery.clone({ where: rewrittenWhere });
    }

    // Cross-source sort: driver must return ALL matching docs (no limit, no sort, no cursor).
    // The sort and pagination will be applied in-memory in #postResolve.
    // Also ensure any FK fields needed for sort lookup are in the select.
    const extraSelect = crossSourceSort
      .map(s => s.localFKField)
      .filter(f => f && !rawQuery.select.includes(f));

    return tquery.clone({
      where: rewrittenWhere,
      sort: {},
      // Change findOne to findMany so we get all candidates for in-memory sort+slice
      op: op === 'findOne' ? 'findMany' : op,
      select: extraSelect.length ? [...rawQuery.select, ...extraSelect] : rawQuery.select,
      limit: undefined,
      skip: undefined,
      first: undefined,
      last: undefined,
      before: undefined,
      after: undefined,
      isCursorPaging: false,
    });
  }

  // ---------------------------------------------------------------------------
  // Phase 2: post-resolution (cross-source SORT + in-memory pagination)
  // ---------------------------------------------------------------------------

  /**
   * Augment results with foreign sort values, sort in-memory, apply original pagination.
   */
  async #postResolve(plan, results) {
    const { crossSourceSort, sortSpec, originalPagination } = plan;
    const { op, limit, skip, first, last, before, after, isCursorPaging } = originalPagination;

    // count: returned as a number — sort is irrelevant; return as-is
    // Null/undefined: nothing to post-process
    if (results == null || typeof results === 'number') return results;
    if (!Array.isArray(results) || !results.length) return results;

    // Batch-fetch sort values from each foreign source and augment result docs
    for (const sortEntry of crossSourceSort) {
      const { localFKField, foreignLookupField, foreignModelName, sortPath, augmentKey, field } = sortEntry;

      // Collect the FK values from the primary results
      const fkValues = [...new Set(
        results.map(doc => doc[localFKField]).flat().filter(Boolean).map(String),
      )];

      if (!fkValues.length) continue;

      // Select just enough from the foreign model to build the sort map
      const topSortField = sortPath ? sortPath.split('.')[0] : null;
      const selectFields = [...new Set([foreignLookupField, topSortField].filter(Boolean))];

      // Batch-fetch (chunked at CHUNK_SIZE to avoid oversized $in queries)
      const foreignDocs = await this.#batchFetch(foreignModelName, foreignLookupField, fkValues, selectFields);

      // Build lookup map: foreignLookupField value → sort value
      // For virtual reverse-links a person can have many books — take the minimum sort value
      // so ordering is deterministic when one primary doc maps to multiple foreign docs.
      const sortMap = new Map();
      foreignDocs.forEach((doc) => {
        const key = String(doc[foreignLookupField]);
        const val = sortPath ? get(doc, sortPath) : doc[foreignLookupField];
        if (!sortMap.has(key) || (val != null && val < sortMap.get(key))) sortMap.set(key, val);
      });

      // Attach sort value as a hidden (non-enumerable) property on each result doc
      results.forEach((doc) => {
        const fkVal = String(doc[localFKField]);
        Object.defineProperty(doc, augmentKey, {
          value: sortMap.get(fkVal) ?? null,
          configurable: true,
          writable: true,
          enumerable: false,
        });
      });
    }

    // In-memory multi-key stable sort using the full original sort spec (priority order preserved)
    results.sort((a, b) => {
      for (const { path, dir, augmentKey } of sortSpec) {
        const aVal = augmentKey != null ? a[augmentKey] : get(a, path);
        const bVal = augmentKey != null ? b[augmentKey] : get(b, path);

        // Nulls sort last regardless of direction
        if (aVal == null && bVal == null) continue;
        if (aVal == null) return 1;
        if (bVal == null) return -1;

        const cmp = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
        if (cmp !== 0) return dir === 'asc' ? cmp : -cmp;
      }
      return 0;
    });

    // Apply pagination in-memory
    let paginated;
    if (isCursorPaging) {
      paginated = this.#applyCursorPagination(results, { first, last, before, after }, sortSpec);
    } else {
      let sliced = results;
      if (skip) sliced = sliced.slice(skip);
      if (limit) sliced = sliced.slice(0, limit);
      paginated = sliced;
    }

    // Strip augmentation keys (non-enumerable so they won't appear in spread/JSON, but tidy up)
    crossSourceSort.forEach(({ augmentKey }) => {
      paginated.forEach(doc => delete doc[augmentKey]);
    });

    // findOne: return the first result (or null)
    if (op === 'findOne') return paginated[0] ?? null;

    return paginated;
  }

  // ---------------------------------------------------------------------------
  // Cursor pagination (in-memory)
  // ---------------------------------------------------------------------------

  /**
   * Apply cursor-style pagination to an already-sorted in-memory result array.
   * Mirrors the semantics of DataLoader.#paginateResults but works without a DB round-trip.
   *
   * `first`/`last` already include the +2 bookend adjustment added by QueryBuilder.
   */
  #applyCursorPagination(results, { first, last, before, after }, sortSpec) {
    // Encode a $cursor on every doc using the current sort field values
    if (sortSpec.length) {
      results.forEach((doc) => {
        const sortValues = sortSpec.reduce((prev, { path, augmentKey }) => {
          prev[path] = augmentKey != null ? doc[augmentKey] : get(doc, path);
          return prev;
        }, {});
        Object.defineProperty(doc, '$cursor', {
          value: Buffer.from(JSON.stringify(sortValues)).toString('base64'),
          configurable: true,
          writable: false,
          enumerable: false,
        });
      });
    }

    let hasNextPage = false;
    let hasPreviousPage = false;
    const limiter = first || last;

    // Trim to the (after, before) open window by cursor string match
    if (after) {
      const idx = results.findIndex(doc => doc.$cursor === after);
      if (idx !== -1) { results = results.slice(idx + 1); hasPreviousPage = true; }
    }
    if (before) {
      const idx = results.findIndex(doc => doc.$cursor === before);
      if (idx !== -1) { results = results.slice(0, idx); hasNextPage = true; }
    }

    // Trim overage (first/last already include the +2 bookend added by QueryBuilder)
    if (limiter) {
      const overage = results.length - (limiter - 2);
      if (overage > 0) {
        if (first) { results.splice(-overage); hasNextPage = true; }
        else { results.splice(0, overage); hasPreviousPage = true; }
      }
    }

    return Object.defineProperty(results, '$pageInfo', {
      value: {
        startCursor: results[0]?.$cursor ?? '',
        endCursor: results[results.length - 1]?.$cursor ?? '',
        hasPreviousPage,
        hasNextPage,
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Batch fetching
  // ---------------------------------------------------------------------------

  /**
   * Fetch docs from a foreign model by a lookup field, chunked at CHUNK_SIZE
   * so no single $in query exceeds driver limits.
   */
  async #batchFetch(modelName, lookupField, ids, selectFields) {
    const chunks = [];
    for (let i = 0; i < ids.length; i += CHUNK_SIZE) chunks.push(ids.slice(i, i + CHUNK_SIZE));

    const results = await Promise.all(
      chunks.map(chunk => this.#resolver.match(modelName).where({ [lookupField]: chunk }).select(selectFields).many()),
    );

    return results.flat();
  }
};
