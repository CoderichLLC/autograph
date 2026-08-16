const Util = require('@coderich/util');
const { isGlob, globToRegex, mergeDeep, JSONParse } = require('../service/AppService');
const Vocabulary = require('./Vocabulary');
const TransactionScope = require('../data/TransactionScope');

// Glob→regex conversion for a where value, vocabulary-aware: operator operands convert per
// their coercion class ($in element-wise, $exists untouched); bare values convert as before.
const convertGlobs = (value) => {
  if (Vocabulary.isOperatorObject(value)) return Vocabulary.mapValues(value, el => (isGlob(el) ? globToRegex(el) : el));
  return Util.map(value, el => (isGlob(el) ? globToRegex(el) : el));
};

// Flatten a where clause by FIELD PATHS only — operator objects are vocabulary VALUES, never
// path segments. This is the operator-aware replacement for Util.flatten in #finalize: flattening
// `{ price: { $ne: -999 } }` to the key 'price.$ne' hands MongoDB a literal field path that
// silently matches nothing (verified empirically), and hands every other driver a reconstruction
// chore. Operator objects arrive at drivers INTACT.
const flattenWhere = (obj, path = [], acc = {}) => {
  Object.entries(obj ?? {}).forEach(([key, value]) => {
    if (Util.isPlainObject(value) && !Vocabulary.isOperatorObject(value) && Object.keys(value).length) flattenWhere(value, path.concat(key), acc);
    else acc[path.concat(key).join('.')] = value;
  });
  return acc;
};

// Deep "merged" view: input first, falls through to doc — recursively for plain objects.
// READ-ONLY. Writes/deletes throw with a hint pointing at `query.input` as the correct
// mutation target. Without this, the default proxy `set` writes through to the target
// (input), which silently lands on `input` for top-level fields but mutates the underlying
// `doc` for nested paths whose parent only exists on doc — a footgun.
// Arrays / ObjectIds / Dates / class instances are returned as-is (positional alignment with
// doc isn't safe to assume). Spread, Object.keys, Object.entries, JSON.stringify, `in`, and
// property access all see the deep-merged view.
const createMergedProxy = (input, doc) => new Proxy(input, {
  get(t, prop) {
    if (typeof prop === 'symbol') return Reflect.get(t, prop);
    const inputVal = t[prop];
    const docVal = doc?.[prop];
    if (Util.isPlainObject(inputVal) && Util.isPlainObject(docVal)) return createMergedProxy(inputVal, docVal);
    return inputVal === undefined ? docVal : inputVal;
  },
  has(t, prop) {
    if (typeof prop === 'symbol') return Reflect.has(t, prop);
    return prop in t || (doc != null && prop in doc);
  },
  ownKeys(t) {
    if (doc == null) return Reflect.ownKeys(t);
    return Array.from(new Set([...Reflect.ownKeys(t), ...Reflect.ownKeys(doc)]));
  },
  getOwnPropertyDescriptor(t, prop) {
    const targetDesc = Reflect.getOwnPropertyDescriptor(t, prop);
    if (targetDesc) return targetDesc;
    if (doc != null) {
      const docDesc = Reflect.getOwnPropertyDescriptor(doc, prop);
      // configurable: true is required to honor proxy invariants for keys not on the target.
      if (docDesc) return { ...docDesc, configurable: true };
    }
    return undefined;
  },
  set(t, prop) {
    throw new TypeError(`query.merged is a read-only computed view — assign to query.input.${String(prop)} instead`);
  },
  deleteProperty(t, prop) {
    throw new TypeError(`query.merged is a read-only computed view — delete query.input.${String(prop)} instead`);
  },
});

// Shared with Emitter so memo keys and DataLoader cache keys can't drift.
// Includes model/crud/id/input on top of the read-path fields:
// - model: per-loader implicit on the read path (constant), used to distinguish on the write path
// - crud:  always 'read' inside a loader (constant), distinguishes pre/post Mutation events
// - id:    merged into `where` by QueryBuilder.id() on reads (redundant), explicit on mutations
// - input: undefined on reads (skipped by stringify), required to distinguish mutations
// - session: DataLoaders are shared across a whole request, including with every isolated
//   transaction cloned from it (see Resolver#clone) — an otherwise-identical read issued with a
//   transaction's session attached (see Resolver#resolve) must not share a cache
//   entry with the same read issued without one (or with a *different* session), or a transactional
//   read's result leaks into a plain read that should never have been able to see it (or vice
//   versa). Tagged via TransactionScope.tagSession — never the raw session, which for MongoDB has
//   circular references that would blow up JSON.stringify.
const computeCacheKey = q => JSON.stringify({
  model: q.model,
  crud: q.crud,
  op: q.op,
  id: q.id,
  input: q.input,
  where: q.where,
  sort: q.sort,
  select: q.select,
  skip: q.skip,
  limit: q.limit,
  before: q.before,
  after: q.after,
  first: q.first,
  last: q.last,
  session: TransactionScope.tagSession(q.options?.session),
});

// A GraphQL selection set for `model`, matching the shape the LOCAL resolver returns — the stored
// document. Scalars and enums by name; an embedded type expanded in full (recursively, cycle-guarded);
// a RELATION reduced to its pk (`{ pkField }` — not always `id`), which a remote client flattens back
// to the bare FK the local resolver would have returned. A connection-marked relation rides the
// generated Connection shape (`{ edges { node { pk } } }`) because `@field(connection: true)` rewrote
// its API type. Virtual (@link) fields are not stored, so the default selection omits them — naming
// one in `select` opts it in, still pk-only.
const buildSelection = (model, select, ancestors = new Set()) => {
  const names = select?.length ? select : Object.keys(model.fields).filter(name => !model.fields[name].isVirtual);
  const parts = names.map((name) => {
    const field = model.fields[name];
    if (!field) return null;
    if (field.isScalar || field.isEnum) return field.name;
    if (!field.model) return null;
    if (field.isEmbedded) {
      if (ancestors.has(field.model)) return null; // an embedded cycle has no finite selection
      return `${field.name} ${buildSelection(field.model, undefined, new Set(ancestors).add(model))}`;
    }
    const pk = `{ ${field.model.pkField} }`;
    return field.isConnection ? `${field.name} { edges { node ${pk} } }` : `${field.name} ${pk}`;
  }).filter(Boolean);
  return `{ ${parts.join(' ')} }`;
};

module.exports = class Query {
  #config;
  #resolver;
  #context;
  #schema;
  #model;
  #query;
  #resolution;
  #cacheKey;

  static computeCacheKey = computeCacheKey;

  constructor(config) {
    const { schema, context, resolver, query, resolution = Promise.withResolvers() } = config;
    this.#config = config;
    this.#resolver = resolver;
    this.#context = context;
    this.#schema = schema;
    this.#model = schema.models[query.model];
    this.#query = query;
    this.#resolution = resolution;
  }

  promise() {
    return this.#resolution.promise;
  }

  resolve() {
    this.#resolution.resolve();
  }

  clone(query) {
    query = { ...this.#query, ...query }; // NO deepMerge here; must replace fields entirely
    return new Query({ ...this.#config, query, resolution: this.#resolution });
  }

  toObject() {
    const { crud } = this.#query;
    if (crud !== 'create' && crud !== 'update' && crud !== 'delete') return this.#query;

    const { doc = {} } = this.#query;
    let target;
    if (crud === 'delete') {
      target = {};
    } else {
      this.#query.input ??= {};
      target = this.#query.input;
    }

    return Object.defineProperty(this.#query, 'merged', {
      value: createMergedProxy(target, doc),
      enumerable: true,
      configurable: true,
    });
  }

  /**
   * Serialize this Query's IR into a GraphQL request `{ query, variables }`, matching the API that
   * Autograph generates (get/find/create/update/delete + Connection). The inverse of the server's
   * GQL → IR parsing — it lets a Query built anywhere be forwarded over the wire (resolver.graphql).
   * Arguments go through GraphQL variables (typed against the generated Input types), so there is no
   * literal escaping and `where`/`input`/`sort` pass through unmodified.
   */
  toGQL() {
    const q = this.#query;
    const M = this.#model.name;
    const args = {}; // name -> [gqlType, value]
    let field;
    let wrap;

    // A where ALWAYS rides the `_` vocabulary slot of the typed `${M}InputWhere` — one
    // serialization path carrying the IR verbatim (operators, compounds, bare-FK operands — none
    // of which the typed fields can express), which the server lifts back out and validates at
    // the query boundary. The typed fields are the human/external-client surface; toGQL never
    // needs them. NOTE this also keeps the DECLARATION (`$where: ${M}InputWhere`) on the name
    // external clients hard-code — the wire stays backward-compatible for everyone but us, and
    // we upgrade client+server together.
    switch (q.op) {
      case 'findOne':
        if (q.id != null) {
          field = `get${M}`; wrap = 'node'; args.id = ['ID!', q.id];
        } else {
          field = `find${M}`; wrap = 'firstNode'; args.where = [`${M}InputWhere`, q.where === undefined ? undefined : { _: q.where }]; args.first = ['Int', 1];
        }
        break;
      case 'findMany':
        field = `find${M}`; wrap = 'connection';
        Object.assign(args, { where: [`${M}InputWhere`, q.where === undefined ? undefined : { _: q.where }], sortBy: [`${M}InputSort`, q.sort], limit: ['Int', q.limit], skip: ['Int', q.skip], first: ['Int', q.first], after: ['String', q.after], last: ['Int', q.last], before: ['String', q.before] });
        break;
      case 'count':
        field = `find${M}`; wrap = 'count'; args.where = [`${M}InputWhere`, q.where === undefined ? undefined : { _: q.where }];
        break;
      case 'createOne': case 'createMany':
        field = `create${M}`; wrap = 'node'; args.input = [`${M}InputCreate!`, q.input];
        break;
      case 'updateOne': case 'updateMany':
        field = `update${M}`; wrap = 'node'; args.id = ['ID!', q.id]; args.input = [`${M}InputUpdate`, q.input];
        break;
      case 'deleteOne': case 'deleteMany':
        field = `delete${M}`; wrap = 'node'; args.id = ['ID!', q.id];
        break;
      default: throw new Error(`toGQL: unsupported op "${q.op}"`);
    }

    // `.meta()` is out-of-band instruction to the mutation (the server's generated resolver routes
    // the argument back into `query.meta`, where hooks read it). It exists on the wire only when
    // the model opted in with `@model(meta: <Type>)` — offered without the declaration, there is
    // no argument to bind it to, so refuse by name rather than silently dropping domain semantics.
    // Read from `q.args.meta`: the builder defaults `q.meta` to `{}`, so only `.meta()` sets args.
    if (q.args?.meta !== undefined && q.isMutation) {
      if (!this.#model.meta) throw new Error(`toGQL: .meta() was given but model "${M}" declares no meta type — the generated ${field} mutation has no meta argument to carry it. Declare it in the SDL: @model(meta: <ScalarOrInputType>).`);
      args.meta = [this.#model.meta, q.args.meta];
    }

    const decls = [];
    const fieldArgs = [];
    const variables = {};
    Object.entries(args).forEach(([name, [type, value]]) => {
      if (value === undefined) return;
      decls.push(`$${name}: ${type}`);
      fieldArgs.push(`${name}: $${name}`);
      variables[name] = value;
    });

    // QueryBuilder's constructor defaults `q.select` to EVERY field name, so it cannot distinguish
    // "the author chose these" from "nobody chose". `.select(…)` records the author's choice in
    // `q.args.select` too — that is the explicitness signal. Defaulted → the stored-document shape
    // (virtuals omitted); explicit → exactly what was named (a virtual is honored, still pk-only).
    const explicitSelect = q.args?.select?.length ? q.select : undefined;
    const selection = wrap === 'count' ? '' : buildSelection(this.#model, explicitSelect);
    const body = {
      node: selection,
      firstNode: `{ edges { node ${selection} } }`,
      connection: `{ count edges { node ${selection} } }`,
      count: '{ count }',
    }[wrap];

    const opType = q.isMutation ? 'mutation' : 'query';
    const opName = field.charAt(0).toUpperCase() + field.slice(1);
    const declStr = decls.length ? `(${decls.join(', ')})` : '';
    const argStr = fieldArgs.length ? `(${fieldArgs.join(', ')})` : '';

    return {
      query: `${opType} ${opName}${declStr} { ${field}${argStr} ${body} }`,
      variables,
    };
  }

  // Unique identity of this query, used by both DataLoader's cacheKeyFn (read path) and
  // Emitter's memoize lookups (all events). Composition lives in `computeCacheKey` above
  // so the two paths can't drift. Lazily cached per Query instance.
  toCacheKey() {
    if (this.#cacheKey !== undefined) return this.#cacheKey;
    this.#cacheKey = computeCacheKey(this.#query);
    return this.#cacheKey;
  }

  /**
   * Transform entire query for user consumption
   */
  transform(asClone = true) {
    let { input, where, sort } = this.#query;
    const args = { query: this.#query, resolver: this.#resolver, context: this.#context };

    if (['create', 'update'].includes(this.#query.crud) && !this.#query.isSaveNative) input = this.#model.transformers[this.#query.crud]?.transform(Util.unflatten(this.#query.input, { safe: true }), args);
    // Validate the where against the vocabulary allowlist AND the parsed model BEFORE any
    // transformation — this is the loud front door for whatever the GraphQL Mixed where argument
    // lets through, and the same guard for local callers (the key-walk silently DROPS unknown
    // keys, so an unvalidated typo deleted its predicate and matched everything). Native wheres
    // are exempt by design: flags({ native }) is the developer's code-level declaration of TRUE
    // driver dialect (raw storage keys, e.g. Mongo $expr) — the guard covers the untrusted path only.
    if (!this.#query.isWhereNative && ['read', 'update', 'delete'].includes(this.#query.crud)) Vocabulary.validate(this.#query.where ?? {}, [], this.#model);
    if (!this.#query.isWhereNative && ['read', 'update', 'delete'].includes(this.#query.crud)) where = this.#transformWhere(Util.unflatten(this.#query.where ?? {}, { safe: true }), args);
    if (!this.#query.isSortNative && ['read'].includes(this.#query.crud)) sort = this.#model.transformers.sort.transform(Util.unflatten(this.#query.sort, { safe: true }), args);

    if (asClone) return this.clone({ input, where, sort });
    this.#query.input = input;
    this.#query.where = where;
    this.#query.sort = sort;
    this.#cacheKey = undefined; // invalidate; $cacheKey getter recomputes on next access
    return this;
  }

  // Compound operators ($or/$and) carry whole where clauses — the field-shaped transformer
  // knows only field names, so compounds are lifted around it and each branch recurses through
  // the SAME transformation (field pipelines reach operands inside every branch).
  #transformWhere(where, args) {
    const { $or, $and, ...fields } = where ?? {};
    const out = this.#model.transformers.where.transform(fields, args);
    if ($or) out.$or = $or.map(branch => this.#transformWhere(Util.unflatten(branch ?? {}, { safe: true }), args));
    if ($and) out.$and = $and.map(branch => this.#transformWhere(Util.unflatten(branch ?? {}, { safe: true }), args));
    return out;
  }

  // Same lift for the domain→data key-walk (walk drops unknown keys, and '$or' is not a field).
  #walkWhere(where) {
    if (!Util.isPlainObject(where)) return where;
    const { $or, $and, ...fields } = where;
    const out = this.#model.walk(fields, node => Object.assign(node, { key: node.field.key }));
    if ($or) out.$or = $or.map(branch => this.#walkWhere(branch));
    if ($and) out.$and = $and.map(branch => this.#walkWhere(branch));
    return out;
  }

  validate() {
    const args = { query: this.#query, resolver: this.#resolver, context: this.#context };
    this.#query.input = this.#model.transformers.validate.transform(this.#query.input, args);
    return this;
  }

  /**
   * Transform entire query for driver. For updates, input is flattened to dot-notation reflecting
   * smart-merge semantics: user-provided leaves overwrite, untouched keys are preserved. Sub-objects
   * whose existing parent in the doc is null/undefined are kept whole (as a whole-object replacement
   * at the parent path), since you can't set sub-fields of a null parent (true of both Mongo $set
   * and Postgres jsonb_set).
   */
  toDriver() {
    const { crud, input, doc, where, sort, before, after, isWhereNative, isSaveNative, isSortNative, isCursorPaging } = this.#query;
    // Native wheres are deliberately NOT vocabulary-validated: flags({ native }) is a code-level
    // developer declaration of TRUE driver dialect (raw column keys, raw driver constructs —
    // e.g. Mongo $expr) — the allowlist guards the untrusted transformed path (transform()),
    // not the developer's explicit escape hatch.
    let $input = isSaveNative ? input : this.#model.transformers.toDriver.transform(input);
    if (crud === 'update' && !isSaveNative) {
      const ignorePaths = [...this.#model.ignorePaths];

      // Embedded @oneOf variant SWITCH → replace the whole subdocument. A partial dot-merge would
      // leave the previous variant's fields behind (a half-morphed doc), so when the incoming
      // discriminator differs from the stored one, $set the entire field. A SAME-variant update
      // falls through to the normal partial-merge path below — an embedded @oneOf then updates like
      // any other embedded document (path of least surprise). Walk the (app-shaped, already-
      // dispatched) input against the stored doc; emit the field's DB-key path, which is what the
      // flatten below matches on the DB-shaped $input.
      (function collectVariantSwitches($model, inputVal, docVal, keyPath) {
        if (!Util.isPlainObject(inputVal)) return;
        Object.entries(inputVal).forEach(([name, iv]) => {
          const field = $model.fields[name];
          if (!field?.isEmbedded || field.isArray || !Util.isPlainObject(iv)) return;
          const subKeyPath = keyPath ? `${keyPath}.${field.key}` : field.key;
          const dv = Util.isPlainObject(docVal) ? docVal[name] : undefined;
          const tf = field.model.oneOf ? field.model.typeField : undefined;
          const dType = tf && Util.isPlainObject(dv) ? dv[tf] : undefined;
          // Only a genuine switch (both discriminators present, differing) forces a whole-field
          // replace; a first-time set (no stored variant) is already handled as a whole-object write
          // by collectNullParents. Same-variant / non-oneOf embeds recurse into the normal merge.
          if (tf && iv[tf] !== undefined && dType !== undefined && iv[tf] !== dType) ignorePaths.push(subKeyPath);
          else collectVariantSwitches(field.model, iv, dv, subKeyPath);
        });
      }(this.#model, input, doc, ''));

      (function collectNullParents($obj, path = '') {
        if (!Util.isPlainObject($obj)) return;
        Object.entries($obj).forEach(([key, val]) => {
          if (!Util.isPlainObject(val)) return;
          const subPath = path ? `${path}.${key}` : key;
          const docVal = subPath.split('.').reduce((acc, p) => (acc == null ? acc : acc[p]), doc);
          if (docVal == null) ignorePaths.push(subPath);
          else collectNullParents(val, subPath);
        });
      }($input));
      $input = Util.flatten($input, { safe: true, ignorePaths });
    }

    const query = this.clone({
      model: this.#model.key,
      select: this.#query.select.map(name => this.#model.fields[name].key),
      input: $input,
      where: isWhereNative ? where : this.#walkWhere(where),
      sort: isSortNative ? sort : this.#model.walk(sort, node => Object.assign(node, { key: node.field.key })),
      before: (!isCursorPaging || !before) ? undefined : JSONParse(Buffer.from(before, 'base64').toString('ascii')),
      after: (!isCursorPaging || !after) ? undefined : JSONParse(Buffer.from(after, 'base64').toString('ascii')),
      $schema: this.#schema.resolvePath,
    });

    if (!isWhereNative) this.#finalize(query.toObject());

    return query;
  }

  /**
   * Finalize the query for the driver
   */
  // Reconstruct a compound-operator branch: same glob/$in/operator treatment as the top level,
  // recursing nested compounds. Join paths are REJECTED inside branches — a disjunctive branch
  // cannot be extracted into the (conjunctive) join machinery, and silently dropping it would
  // lie; loud beats blurry.
  #finalizeBranch(branch) {
    const { $or, $and, ...fields } = branch ?? {};
    const out = Object.entries(flattenWhere(fields)).reduce((prev, [key, value]) => {
      if (this.#model.isJoinPath(key, 'key')) throw new Error(`Unsupported where clause: join path "${key}" inside $or/$and — compound branches must use direct (non-join) fields`);
      value = convertGlobs(value);
      if (Array.isArray(value)) value = { $in: value };
      return Object.assign(prev, { [key]: value });
    }, {});
    if ($or) out.$or = $or.map(b => this.#finalizeBranch(b));
    if ($and) out.$and = $and.map(b => this.#finalizeBranch(b));
    return out;
  }

  #finalize(query) {
    const { where = {}, sort = {} } = query;
    const { $or, $and, ...whereFields } = where;
    const flatSort = Util.flatten(sort, { safe: true });
    const flatWhere = flattenWhere(whereFields); // operator-aware: operator objects stay intact as values
    const $sort = Util.unflatten(Object.keys(flatSort).reduce((prev, key) => Object.assign(prev, { [key]: {} }), {}), { safe: true });

    //
    query.sort = this.#model.walk(sort, (node) => {
      if (node.field.isVirtual || node.field.isFKReference) node.key = `join_${node.field.model.key}`;
      return node;
    }, { key: 'key' });

    // Reconstruct the where clause by pulling out anything that requires a join.
    // BARE arrays are normalized to { $in: [...] } here (core owns this; drivers receive
    // pre-normalized queries); explicit operator objects pass through intact — their operands
    // get glob conversion per the vocabulary's coercion classes, never re-wrapping.
    query.where = Object.entries(flatWhere).reduce((prev, [key, value]) => {
      if (this.#model.isJoinPath(key, 'key')) return prev;
      value = convertGlobs(value);
      if (Array.isArray(value)) value = { $in: value };
      return Object.assign(prev, { [key]: value });
    }, {});
    if ($or) query.where.$or = $or.map(b => this.#finalizeBranch(b));
    if ($and) query.where.$and = $and.map(b => this.#finalizeBranch(b));

    // Determine what join data is needed (derived from where + sort)
    const joinData = mergeDeep($sort, Util.unflatten(Object.entries(flatWhere).reduce((prev, [key, value]) => {
      if (this.#model.isJoinPath(key, 'key')) return Object.assign(prev, { [key]: value });
      return prev;
    }, {}), { safe: true }));

    // (Batch-key inference removed — DataLoader now detects merge candidates by examining all
    // queries arriving in the tick, finding subsets that differ in exactly one where-key. The
    // prior single-key heuristic produced false negatives whenever a hook added a scoping field
    // to the where clause.)

    // Construct joins
    const joinsByPath = {};
    query.joins = [];

    // Recursively search a join tree for the first join matching a target model key
    const findJoin = (joins, modelKey) => {
      for (const j of joins) {
        if (j.to === modelKey) return j;
        const found = findJoin(j.children, modelKey);
        if (found) return found;
      }
      return null;
    };

    this.#model.walk(joinData, (node) => {
      const { model, field, key, value, isLeaf, path, run } = node;

      if (field.join) {
        let isArray;
        const join = { ...field.join, where: {}, children: [] };

        if (run.length > 1) {
          join.from = path.reduce((prev, curr, i) => {
            const $field = this.#model.resolvePath(path.slice(0, i + 1).join('.'), 'key');
            if ($field.isArray) isArray = true;
            return prev.concat($field.linkField.key);
          }, []).join('.');
        }

        join.isArray = isArray || model.resolvePath(join.from).isArray;

        // Find the nearest ancestor FK join by scanning ancestor paths from closest to farthest.
        // Joins reached through embedded fields have no FK ancestor and stay at the root level.
        const parentJoin = path.slice(0, -1).reduceRight((found, _, i) => found || joinsByPath[path.slice(0, i + 1).join('.')], null);

        if (parentJoin) {
          parentJoin.children.push(join);
        } else {
          query.joins.push(join);
        }
        joinsByPath[path.join('.')] = join;
      }

      if (isLeaf) {
        const $model = field.model || model;
        const join = findJoin(query.joins, $model.key);
        const $value = convertGlobs(value);
        const $$value = Array.isArray($value) ? { $in: $value } : $value;
        const from = field.model ? join.from : key;
        join.where[from] = $$value;
        return false;
      }

      return node;
    }, { key: 'key' });
  }
};
