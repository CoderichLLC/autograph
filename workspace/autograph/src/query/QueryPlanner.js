const get = require('lodash.get');
const Util = require('@coderich/util');
const Vocabulary = require('./Vocabulary');

const CHUNK_SIZE = 500;

/**
 * QueryPlanner — driver-less join resolution.
 *
 * A driver-level join is impossible in two cases, and BOTH ride the same two-phase pipeline:
 *   - CROSS-SOURCE: the query spans data sources (e.g. Book on Postgres, Person on MongoDB)
 *   - CAPABILITY: the root model's source does not declare 'joins' in `supports` — the
 *     consumer's statement (they know the driver AND the deployment) that the driver must
 *     never receive `query.joins`. Honored, never thrown: the fallback is fully functional.
 *
 *   Phase 1 (pre):  driver-less WHERE paths → pre-query the join target → inject $in
 *   Phase 2 (post): driver-less SORT paths  → batch-fetch sort values  → in-memory sort + paginate
 *
 * Driver-joinable WHERE/SORT/limit/skip are passed through to the driver unchanged.
 * Drivers never see any artefact of either case. (Historical naming: plan fields say
 * `crossSource*` — read as "planner-resolved".) WHERE lifts cover FK-first-segment sub-paths,
 * embedded-prefix stored FKs ('pins.writer.name' → inject at the local 'pins.writer' column),
 * and bare virtual equality ('articles' → condition on the foreign pk). The loud edges — cases
 * that REJECT on a joins-incapable source rather than letting the driver silently drop the
 * constraint: a WHERE on a virtual link behind an embedded prefix (no local column to inject
 * at), and any join-shaped SORT deeper than a first-segment FK (sorting by a multi-valued
 * joined attribute is ill-defined). NOTE the in-memory sort fallback is correctness-first,
 * not perf-neutral: it fetches the full unpaginated result to sort/paginate in process.
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

    // OPERATOR-AWARE flatten (never Util.flatten here): an operator object is a vocabulary
    // VALUE, not a path — generic flattening turned `{ tags: { $exists: false } }` into the
    // path 'tags.$exists', which the FK walk below misread as a JOIN sub-path and pre-queried
    // the foreign model with a dangling operator (dropped by its transform → match-all).
    const flatWhere = Vocabulary.flattenWhere(where);
    const flatSort = Util.flatten(sort, { safe: true });

    // Joins execute in the ROOT source's driver ($lookup / SQL JOIN on the root table), so the
    // capability that decides planner-vs-driver is the ROOT source's. A sourceless model (bare
    // test schemas) keeps the legacy driver path.
    const rootJoins = !rootSource || rootSource.supports.includes('joins');

    // WHERE: group planner-resolved conditions by their FK prefix. The FK segment may sit past
    // an EMBEDDED prefix ('pins.writer.name' — Pin embedded on Writer, Pin.writer the FK): the
    // walk finds the first FK/virtual segment, and the lift injects at the full prefix path
    // ('pins.writer' is a real local column on the embedded docs). A BARE virtual path
    // ('articles' with no sub-path) lifts too — its condition is the foreign model's own pk.
    const whereGroupsByField = {};
    const sameSourceWhere = {};

    for (const [path, value] of Object.entries(flatWhere)) {
      const segments = path.split('.');

      // Walk to the first FK/virtual segment (embedded prefixes pass through; unknown/operator
      // segments end the walk — they can never lead to an FK).
      let fkIndex = -1;
      let fkField = null;
      for (let i = 0; i < segments.length; i += 1) {
        let f;
        try { f = model.resolvePath(segments.slice(0, i + 1).join('.')); } catch { break; }
        if (!f) break;
        if (f.isVirtual || f.isFKReference) { fkIndex = i; fkField = f; break; }
      }

      const foreignSource = fkField?.model?.source;
      const subPath = fkIndex >= 0 ? segments.slice(fkIndex + 1).join('.') : '';
      // Lift when the root driver can't be handed the join (foreign source, or no 'joins'
      // capability). A bare STORED FK at any depth is a plain local column — never a join.
      const needsLift = fkField && foreignSource && (foreignSource !== rootSource || !rootJoins);
      const isBareStoredFK = fkField && !fkField.isVirtual && !subPath;

      if (!needsLift || isBareStoredFK) {
        sameSourceWhere[path] = value;
      } else if (fkField.isVirtual && fkIndex > 0) {
        // A virtual link behind an embedded prefix has no local column to inject at — the only
        // genuinely unliftable WHERE shape. Loud beats silently dropping the constraint.
        throw new Error(`Unsupported where: join path "${path}" cannot be planner-resolved (virtual link behind an embedded prefix) and the data source does not support driver joins`);
      } else if (!subPath && Vocabulary.isOperatorObject(value)) {
        // An operator object on a bare VIRTUAL link has no local column to predicate, and $in
        // injection cannot express its complement ($exists: false = "rows with NO links" needs
        // an anti-join). A stored FK never reaches here (bare stored FKs are local columns,
        // handled above). Loud beats over-matching.
        throw new Error(`Unsupported where: operator on virtual link "${path}" (${Object.keys(value).join(', ')}) cannot be planner-resolved — predicate a field of the linked model instead (e.g. { ${path}: { <field>: … } })`);
      } else {
        const groupKey = segments.slice(0, fkIndex + 1).join('.');
        if (!whereGroupsByField[groupKey]) {
          whereGroupsByField[groupKey] = {
            conditions: {},
            // Where to inject the $in result on THIS model's where clause: the FK prefix path
            // itself (stored side — a local, possibly embedded-dotted column), or the root pk
            // (virtual side).
            localInjectField: fkField.isVirtual ? model.pkField : groupKey,
            // Which field to SELECT from the foreign model (gives us the values to inject)
            foreignSelectField: fkField.isVirtual ? fkField.linkBy : fkField.fkField,
            foreignModelName: fkField.model.name,
          };
        }
        // Bare virtual equality filters BY the foreign model's pk itself.
        whereGroupsByField[groupKey].conditions[subPath || fkField.model.pkField] = value;
      }
    }

    const crossSourceWhere = Object.values(whereGroupsByField);

    // SORT: process in original insertion order so multi-key sort priority is preserved.
    // If ANY key is cross-source, ALL sort + ALL pagination is stripped from the driver
    // query and applied in-memory after augmenting results with foreign sort values.
    const sortSpec = []; // full sort spec in original priority order, for in-memory sort

    for (const [path, direction] of Object.entries(flatSort)) {
      const [fieldName, ...subParts] = path.split('.');
      const field = model.fields[fieldName];
      const dir = String(direction || 'asc').toLowerCase();
      const isCrossSource = Boolean(
        field?.isFKReference && subParts.length && field.model?.source
        && (field.model.source !== rootSource || !rootJoins),
      );

      let localFKField = null;
      let foreignLookupField = null;
      if (isCrossSource) {
        localFKField = field.isVirtual ? model.pkField : fieldName;
        foreignLookupField = field.isVirtual ? field.linkBy : field.fkField;
      }

      sortSpec.push({
        path,
        dir,
        isCrossSource,
        // Keyed by the FULL path — two sort keys sharing a first segment ('authored.chapters.name'
        // + 'authored.chapters.temp') must not clobber each other's augment values.
        augmentKey: isCrossSource ? `__xsort_${path}` : null,
        fieldName: isCrossSource ? fieldName : null,
        sortPath: isCrossSource ? subParts.join('.') : null, // sub-path within foreign model
        localFKField,
        foreignLookupField,
        foreignModelName: isCrossSource ? field.model.name : null,
      });
    }

    const crossSourceSort = sortSpec.filter(s => s.isCrossSource);

    // SORT is only planner-resolved when the FK is the path's FIRST segment (the in-memory
    // sort above). Deeper join-shaped sorts — an embedded prefix ('pins.writer.name') means
    // sorting by a MULTI-VALUED joined attribute (which pin?), and a bare virtual sort
    // ('articles') means sorting by a collection — are ill-defined; they would otherwise flow
    // to #finalize, land in query.joins, and be silently DROPPED by a driver that doesn't
    // join. Loud beats silent over-matching.
    if (!rootJoins) {
      sortSpec.filter(s => !s.isCrossSource).forEach((s) => {
        if (model.isJoinPath(s.path)) throw new Error(`Unsupported sort: join path "${s.path}" requires driver join support ('joins' is not in the data source's supports) — only sorts whose first segment is the FK can be planner-resolved`);
      });
    }

    return {
      hasCrossSource: crossSourceWhere.length > 0 || crossSourceSort.length > 0,
      model,
      op,
      crossSourceWhere,
      crossSourceSort,
      sortSpec,
      sameSourceWhere,
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
    const { crossSourceWhere, crossSourceSort, sameSourceWhere, model, op } = plan;
    const rawQuery = tquery.toObject();

    // Start from the driver-joinable where paths only (already transformed — see below)
    const rewrittenFlat = { ...sameSourceWhere };

    // Deliberately NO .select() narrowing: internal reads stay SUPERSET (the default select) so
    // the pre-query shares one DataLoader cache identity — and one merge bucket — with any
    // same-shaped user read in the request. A narrowed select would be a private cache island
    // (select is part of both the cache key and the merge fingerprint).
    const preQueryResults = await Promise.all(
      crossSourceWhere.map(({ conditions, localInjectField, foreignSelectField, foreignModelName }) => this.#resolver.match(foreignModelName)
        .where(conditions)
        .many()
        .then(docs => ({
          localInjectField,
          ids: docs.map(d => d[foreignSelectField]).flat().filter(Boolean),
        }))),
    );

    for (const { localInjectField, ids } of preQueryResults) {
      if (!ids.length) return null; // short-circuit — no primary results possible
      // Injected values are DESERIALIZED foreign values (string ids), and the rewritten query
      // re-enters POST-transform — so this entry alone must ride the where pipelines here
      // ($cast/generator: string → ObjectId on ObjectId-keyed models) or it silently matches
      // nothing. sameSourceWhere is already transformed; re-transforming it would double-apply.
      // Injected as an array; Query.#finalize() normalises arrays to { $in: [...] }.
      const args = { query: rawQuery, resolver: this.#resolver, context: this.#resolver.getContext() };
      const entry = model.transformers.where.transform(Util.unflatten({ [localInjectField]: ids }, { safe: true }), args);
      Object.assign(rewrittenFlat, Util.flatten(entry, { safe: true }));
    }

    const rewrittenWhere = Util.unflatten(rewrittenFlat, { safe: true });

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

    // Batch-fetch sort values from each foreign source and augment result docs (in parallel)
    await Promise.all(crossSourceSort.map(async (sortEntry) => {
      const { localFKField, foreignLookupField, foreignModelName, sortPath, augmentKey } = sortEntry;

      // Collect the FK values from the primary results
      const fkValues = [...new Set(
        results.map(doc => doc[localFKField]).flat().filter(Boolean).map(String),
      )];

      if (!fkValues.length) return;

      // Batch-fetch (chunked at CHUNK_SIZE to avoid oversized $in queries). Superset select —
      // same doctrine as the pre-query above: no private cache islands.
      const foreignDocs = await this.#batchFetch(foreignModelName, foreignLookupField, fkValues);

      // Resolve the sort value for each foreign doc. The sub-path may itself cross FK links
      // ('authored.chapters.name' → sortPath 'chapters.name' where Book.chapters is another
      // virtual link) — #hopSortValues recurses hop by hop, batch-fetching each level.
      const values = sortPath
        ? await this.#hopSortValues(foreignModelName, sortPath, sortEntry.dir, foreignDocs)
        : foreignDocs.map(doc => doc[foreignLookupField]);

      // Build lookup map: foreignLookupField value → sort value. A primary doc can map to many
      // foreign docs (virtual reverse-links) — reduce direction-aware (min for asc, max for
      // desc), matching the unwind→sort→first-occurrence semantics a joining driver produces.
      const sortMap = new Map();
      foreignDocs.forEach((doc, i) => {
        const key = String(doc[foreignLookupField]);
        const val = values[i];
        if (val == null) { if (!sortMap.has(key)) sortMap.set(key, null); return; }
        const prev = sortMap.get(key);
        if (prev == null || (sortEntry.dir === 'asc' ? val < prev : val > prev)) sortMap.set(key, val);
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
    }));

    // In-memory multi-key stable sort using the full original sort spec (priority order preserved)
    results.sort((a, b) => {
      for (const { path, dir, augmentKey } of sortSpec) {
        const aVal = augmentKey != null ? a[augmentKey] : get(a, path);
        const bVal = augmentKey != null ? b[augmentKey] : get(b, path);

        // Nulls sort last regardless of direction
        if (aVal != null || bVal != null) {
          if (aVal == null) return 1;
          if (bVal == null) return -1;
          let cmp = 0;
          if (aVal < bVal) cmp = -1;
          else if (aVal > bVal) cmp = 1;
          if (cmp !== 0) return dir === 'asc' ? cmp : -cmp;
        }
      }
      return 0;
    });

    // Apply pagination in-memory
    let paginated;
    if (isCursorPaging) {
      paginated = QueryPlanner.#applyCursorPagination(results, { first, last, before, after }, sortSpec);
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

  /**
   * Resolve a sort sub-path against a set of docs, recursing through FK links: when the path's
   * head is itself an FK reference with more path remaining, batch-fetch the next model and
   * reduce each doc's (possibly multi-valued) hop direction-aware — min for asc, max for desc.
   * Returns an array of sort values aligned with `docs`.
   */
  async #hopSortValues(modelName, sortPath, dir, docs) {
    const model = this.#schema.models[modelName];
    const [head, ...rest] = sortPath.split('.');
    const field = model.fields[head];

    // Terminal: the remaining path resolves within these docs (plain/embedded fields).
    if (!(field?.isFKReference && rest.length)) return docs.map(doc => get(doc, sortPath));

    // FK hop: same local/lookup derivation as the top-level cross-source sort entries.
    const localKey = field.isVirtual ? model.pkField : head;
    const lookupField = field.isVirtual ? field.linkBy : field.fkField;
    const fkValues = [...new Set(docs.map(doc => doc[localKey]).flat().filter(Boolean).map(String))];
    const nextDocs = fkValues.length ? await this.#batchFetch(field.model.name, lookupField, fkValues) : [];
    const nextValues = await this.#hopSortValues(field.model.name, rest.join('.'), dir, nextDocs);

    const reduced = new Map();
    nextDocs.forEach((doc, i) => {
      const val = nextValues[i];
      if (val == null) return;
      Util.ensureArray(doc[lookupField]).forEach((k) => {
        const key = String(k);
        const prev = reduced.get(key);
        if (prev == null || (dir === 'asc' ? val < prev : val > prev)) reduced.set(key, val);
      });
    });

    return docs.map((doc) => {
      const vals = Util.ensureArray(doc[localKey]).map(v => reduced.get(String(v))).filter(v => v != null);
      if (!vals.length) return null;
      return vals.reduce((a, b) => {
        const better = dir === 'asc' ? b < a : b > a;
        return better ? b : a;
      });
    });
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
  static #applyCursorPagination(results, { first, last, before, after }, sortSpec) {
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
        if (first) {
          results.splice(-overage);
          hasNextPage = true;
        } else {
          results.splice(0, overage);
          hasPreviousPage = true;
        }
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
  async #batchFetch(modelName, lookupField, ids) {
    const chunks = [];
    for (let i = 0; i < ids.length; i += CHUNK_SIZE) chunks.push(ids.slice(i, i + CHUNK_SIZE));

    const results = await Promise.all(
      chunks.map(chunk => this.#resolver.match(modelName).where({ [lookupField]: chunk }).many()),
    );

    return results.flat();
  }
};
