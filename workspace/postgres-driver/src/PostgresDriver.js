const pg = require('pg');
const knexLib = require('knex');
const Util = require('@coderich/util');

// Knex instance used purely as a query builder — never executes queries directly.
const knex = knexLib({ client: 'pg' });

// ISO-8601 date pattern used to revive date strings stored inside JSONB.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

module.exports = class PostgresDriver {
  #pool;
  #config;
  // Software-level transaction isolation (needed because pg-mem writes are always immediately visible).
  // Each active transaction gets a context that tracks IDs it created.
  // Reads without a session filter out ALL pending IDs; reads within a session obey snapshot semantics.
  #allPendingIds = new Set();
  #txnContexts = new Map();

  constructor({ pool, uri, ...config } = {}) {
    this.#config = config;
    this.#pool = pool || new pg.Pool({ connectionString: uri });
  }

  prepare(query) {
    // Re-assemble MongoDB-style operators that autograph flattens via Util.flatten:
    // e.g. { 'price.$ne': -999 } → { price: { $ne: -999 } }
    const where = PostgresDriver.unFlattenOperators(query.where);

    const plan = { op: query.op, model: query.model, session: query.options?.session };

    switch (query.op) {
      case 'findOne':
      case 'findMany': {
        const { dbWhere, jsFilters } = PostgresDriver.splitWhere(where, query.$schema, query.model);
        plan.jsFilters = jsFilters;
        plan.arrayJoins = [];
        plan.sql = PostgresDriver.buildSelect({ ...query, where: dbWhere }, false, plan.arrayJoins);
        // Sort by joined column: SQL can't use DISTINCT (ORDER BY column not in SELECT).
        // Use SELECT model.* to avoid PK column conflicts, and deduplicate in JS after sorting.
        if (query.joins?.length) {
          const flatSort = Object.entries(Util.flatten(query.sort || {}, { safe: true }));
          if (flatSort.some(([k]) => k.startsWith('join_'))) plan.deduplicateByPk = true;
        }
        break;
      }
      case 'count': {
        const { dbWhere, jsFilters } = PostgresDriver.splitWhere(where, query.$schema, query.model);
        plan.jsFilters = jsFilters;
        if (jsFilters.length) {
          plan.arrayJoins = [];
          plan.sql = PostgresDriver.buildSelect({ ...query, where: dbWhere }, false, plan.arrayJoins);
          plan.isJsCount = true;
        } else {
          plan.arrayJoins = [];
          plan.sql = PostgresDriver.buildSelect({ ...query, where }, false, plan.arrayJoins);
          if (!plan.arrayJoins.length) {
            plan.sql = PostgresDriver.buildSelect({ ...query, where }, true);
          }
        }
        break;
      }
      case 'createOne':
        plan.sql = knex(query.model).insert(PostgresDriver.serializeInput(query.input)).returning('*');
        break;
      case 'updateOne': {
        // Detect partial JSONB updates (dotted keys targeting embedded objects).
        // These require a read-merge-write approach since jsonb_set may not be available.
        const hasPartialJsonb = PostgresDriver.hasPartialJsonbUpdate(query.input, query.$schema, query.model);
        if (hasPartialJsonb) {
          plan.partialJsonb = { input: query.input, where };
          plan.sql = knex(query.model).where(PostgresDriver.buildWhereCallback(where)).select('*');
        } else {
          plan.sql = knex(query.model)
            .where(PostgresDriver.buildWhereCallback(where))
            .update(PostgresDriver.serializeInput(query.input))
            .returning('*');
        }
        break;
      }
      case 'deleteOne':
        plan.sql = knex(query.model).where(PostgresDriver.buildWhereCallback(where)).delete();
        break;
      case 'deleteMany':
        plan.sql = knex(query.model).where(PostgresDriver.buildWhereCallback(where)).delete();
        break;
      default:
        break;
    }

    return plan;
  }

  execute(plan) {
    return Util.promiseRetry(
      () => this[plan.op](plan),
      5, 5,
      e => e.message?.includes('could not serialize access'),
    );
  }

  async findOne(plan) {
    const hasExtra = plan.arrayJoins?.length || plan.jsFilters?.length || plan.deduplicateByPk;
    const builder = hasExtra ? plan.sql : plan.sql.limit(1);
    let rows = await this.#run(builder, plan.session);
    if (plan.arrayJoins?.length) rows = await this.#applyArrayJoins(rows, plan.arrayJoins, plan.session);
    rows = PostgresDriver.applyJsFilters(rows, plan.jsFilters);
    if (plan.deduplicateByPk) rows = PostgresDriver.deduplicateByPk(rows);
    rows = this.#filterPending(rows, plan.session);
    return rows[0] ?? null;
  }

  async findMany(plan) {
    let rows = await this.#run(plan.sql, plan.session);
    if (plan.arrayJoins?.length) rows = await this.#applyArrayJoins(rows, plan.arrayJoins, plan.session);
    rows = PostgresDriver.applyJsFilters(rows, plan.jsFilters);
    if (plan.deduplicateByPk) rows = PostgresDriver.deduplicateByPk(rows);
    return this.#filterPending(rows, plan.session);
  }

  async count(plan) {
    if (plan.isJsCount || plan.arrayJoins?.length) {
      let rows = await this.#run(plan.sql, plan.session);
      if (plan.arrayJoins?.length) rows = await this.#applyArrayJoins(rows, plan.arrayJoins, plan.session);
      return PostgresDriver.applyJsFilters(rows, plan.jsFilters).length;
    }
    return this.#run(plan.sql, plan.session).then(rows => Number(rows[0]?.count ?? 0));
  }

  // Resolve JSONB array FK joins (friends, sections.person) in JS.
  // For each join: query the target table with its conditions, get matching PKs,
  // then filter the main rows by containment.
  async #applyArrayJoins(rows, arrayJoins, session) {
    let result = rows;
    for (const aj of arrayJoins) {
      // Build SELECT for matching PKs in target table.
      const innerArrayJoins = [];
      let q = knex(aj.to).distinct(`${aj.to}.${aj.pkCol}`);
      const joinedTables = new Set([aj.to]);
      const seenTables = new Map();
      if (aj.children?.length) {
        PostgresDriver.applyJoins(q, aj.to, aj.children, joinedTables, seenTables, aj.$schema, innerArrayJoins);
      }
      if (aj.joinWhere && Object.keys(aj.joinWhere).length) {
        q = q.where(PostgresDriver.buildWhereCallback(aj.joinWhere, joinedTables, aj.$schema, aj.to, aj.to));
      }
      const pkRows = await this.#run(q, session);
      const matchingPks = new Set(pkRows.map(r => String(r[aj.pkCol])));

      if (matchingPks.size === 0) { result = []; break; }

      if (aj.type === 'directArray') {
        // row[localField] is JSONB array of IDs — check containment
        result = result.filter((row) => {
          const arr = row[aj.localField];
          if (!Array.isArray(arr)) return false;
          return arr.some(id => matchingPks.has(String(id)));
        });
      } else {
        // 'embeddedArray': row[arrayCol] is JSONB array of objects, elem[elemFk] is the PK
        const pathParts = aj.elemFk.split('.');
        result = result.filter((row) => {
          const arr = row[aj.arrayCol];
          if (!Array.isArray(arr)) return false;
          return arr.some((elem) => {
            const v = pathParts.reduce((obj, k) => obj?.[k], elem);
            return v != null && matchingPks.has(String(v));
          });
        });
      }
    }
    return result;
  }

  createOne(plan) {
    return this.#run(plan.sql, plan.session).then(rows => {
      const row = rows[0];
      if (row && plan.session) {
        const ctx = this.#txnContexts.get(plan.session);
        if (ctx) {
          const id = row._id;
          ctx.ownPending.add(id);
          this.#allPendingIds.add(id);
          if (!ctx.ownPendingByModel.has(plan.model)) ctx.ownPendingByModel.set(plan.model, new Set());
          ctx.ownPendingByModel.get(plan.model).add(id);
        }
      }
      return row;
    });
  }

  async updateOne(plan) {
    if (plan.partialJsonb) {
      // Read current row, deep-merge partial updates, then write back.
      const current = await this.#run(plan.sql, plan.session).then(rows => rows[0]);
      if (!current) return null;
      const merged = PostgresDriver.mergePartialJsonb(current, plan.partialJsonb.input);
      const { sql, bindings } = knex(plan.model)
        .where(PostgresDriver.buildWhereCallback(plan.partialJsonb.where))
        .update(PostgresDriver.serializeInput(merged))
        .returning('*')
        .toSQL().toNative();
      const executor = plan.session || this.#pool;
      const r = await executor.query(sql, bindings);
      return r.rows[0] ? PostgresDriver.reviveRow(r.rows[0]) : null;
    }
    return this.#run(plan.sql, plan.session).then(rows => rows[0] ?? null);
  }

  deleteOne(plan) { return this.#run(plan.sql, plan.session); }
  deleteMany(plan) { return this.#run(plan.sql, plan.session); }

  collection(name) {
    return { query: (...args) => this.#pool.query(...args) };
  }

  // Raw table accessor used by Driver Queries and Bug Fixes tests.
  driver(name) {
    const pool = this.#pool;
    const revive = PostgresDriver.reviveRow;
    return {
      findOne: async (where) => {
        const q = Object.keys(where || {}).length ? knex(name).where(where).limit(1) : knex(name).limit(1);
        const { sql, bindings } = q.toSQL().toNative();
        const r = await pool.query(sql, bindings);
        return r.rows[0] ? revive(r.rows[0]) : null;
      },
      findMany: async (where) => {
        const { sql, bindings } = knex(name).where(where || {}).toSQL().toNative();
        const r = await pool.query(sql, bindings);
        return r.rows.map(revive);
      },
      find: async (where) => {
        const { sql, bindings } = knex(name).where(where || {}).toSQL().toNative();
        const r = await pool.query(sql, bindings);
        const rows = r.rows.map(revive);
        return { toArray: () => Promise.resolve(rows) };
      },
      // MongoDB-style update: applies $set patch without replacing entire document.
      findOneAndUpdate: async (where, update) => {
        const patch = update.$set || update;
        const serialized = PostgresDriver.serializeInput(patch);
        const { sql, bindings } = knex(name)
          .where(where || {})
          .update(serialized)
          .returning('*')
          .toSQL().toNative();
        const r = await pool.query(sql, bindings);
        return r.rows[0] ? revive(r.rows[0]) : null;
      },
    };
  }

  disconnect() { return this.#pool.end(); }

  transaction() {
    return new Promise((resolve, reject) => {
      this.#pool.connect().then((client) => {
        client.query('BEGIN').then(() => {
          let closed = false;

          // Snapshot of IDs pending in OTHER active transactions when this transaction starts.
          const exclusions = new Set(this.#allPendingIds);
          const ownPending = new Set();
          const ownPendingByModel = new Map();

          // Unique wrapper — used as the Map key for this transaction's context.
          // Delegates actual SQL to the underlying client.
          const sessionWrapper = { query: (...args) => client.query(...args) };
          // postSnapshotIds: IDs committed by OTHER transactions AFTER this snapshot was taken.
          // These must be hidden from this transaction (snapshot isolation semantics).
          const postSnapshotIds = new Set();
          this.#txnContexts.set(sessionWrapper, { ownPending, exclusions, ownPendingByModel, postSnapshotIds });

          const close = async (cmd) => {
            if (closed) return undefined;
            closed = true;

            if (cmd === 'ROLLBACK') {
              // pg-mem doesn't support real rollback — manually delete rows this txn inserted.
              for (const [model, ids] of ownPendingByModel) {
                if (ids.size > 0) {
                  const placeholders = [...ids].map((_, i) => `$${i + 1}`).join(', ');
                  await this.#pool.query(`DELETE FROM "${model}" WHERE "_id" IN (${placeholders})`, [...ids]); // eslint-disable-line no-await-in-loop
                }
              }
            }

            // On COMMIT: propagate this txn's created IDs to all still-active transactions'
            // postSnapshotIds so they remain hidden (snapshot isolation — they pre-date this commit).
            if (cmd === 'COMMIT') {
              for (const [, otherCtx] of this.#txnContexts) {
                for (const id of ownPending) otherCtx.postSnapshotIds.add(id);
              }
            }

            // Remove this txn's IDs from the global pending set.
            for (const id of ownPending) this.#allPendingIds.delete(id);
            this.#txnContexts.delete(sessionWrapper);

            return client.query(cmd).finally(() => client.release());
          };

          resolve(Object.defineProperties({}, {
            session: { value: sessionWrapper, enumerable: true },
            commit: { value: () => close('COMMIT') },
            rollback: { value: () => close('ROLLBACK') },
          }));
        }).catch(reject);
      }).catch(reject);
    });
  }

  // Filter rows based on software transaction isolation semantics.
  // Without a session: exclude all IDs pending in active transactions.
  // Within a session: include own pending; exclude IDs that were pending in other txns at start (snapshot).
  #filterPending(rows, session) {
    if (this.#allPendingIds.size === 0) return rows;
    const ctx = session ? this.#txnContexts.get(session) : null;
    return rows.filter((row) => {
      const { _id: id } = row;
      if (!id) return true;
      if (!ctx) return !this.#allPendingIds.has(id);
      if (ctx.ownPending.has(id)) return true;
      if (ctx.exclusions.has(id)) return false;
      if (ctx.postSnapshotIds?.has(id)) return false;
      for (const [otherSess, otherCtx] of this.#txnContexts) {
        if (otherSess !== session && otherCtx.ownPending.has(id)) return false;
      }
      return true;
    });
  }

  // Execute a knex builder using session (transaction client) or pool.
  #run(builder, session) {
    const { sql, bindings } = builder.toSQL().toNative();
    if (process.env.DEBUG_SQL) console.log('[SQL]', sql, bindings);
    const executor = session || this.#pool;
    return executor.query(sql, bindings).then(r => r.rows.map(PostgresDriver.reviveRow));
  }

  // Deduplicate rows by _id (PK column), preserving order (first occurrence wins).
  static deduplicateByPk(rows) {
    const seen = new Set();
    return rows.filter((r) => {
      const pk = r._id;
      if (seen.has(pk)) return false;
      seen.add(pk);
      return true;
    });
  }

  // Revive ISO-8601 strings nested inside JSONB objects/arrays to Date instances.
  static reviveRow(row) {
    if (!row || typeof row !== 'object') return row;
    function revive(v) {
      if (typeof v === 'string' && ISO_DATE.test(v)) return new Date(v);
      if (Array.isArray(v)) return v.map(revive);
      if (v && typeof v === 'object' && !(v instanceof Date)) {
        return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, revive(val)]));
      }
      return v;
    }
    return Object.fromEntries(
      Object.entries(row).map(([k, v]) => {
        if (Array.isArray(v) || (v && typeof v === 'object' && !(v instanceof Date))) {
          return [k, revive(v)];
        }
        return [k, v];
      }),
    );
  }

  // Autograph calls Util.flatten on WHERE before passing to the driver, which flattens
  // MongoDB-style operator objects: { price: { $ne: -999 } } → { 'price.$ne': -999 }.
  // Reconstruct them so the rest of the driver logic can handle them normally.
  static unFlattenOperators(where) {
    if (!where) return where;
    const result = {};
    Object.entries(where).forEach(([col, value]) => {
      const lastDot = col.lastIndexOf('.');
      if (lastDot !== -1) {
        const field = col.slice(lastDot + 1);
        if (field.startsWith('$')) {
          const parent = col.slice(0, lastDot);
          if (!result[parent] || typeof result[parent] !== 'object' || Array.isArray(result[parent])) {
            result[parent] = {};
          }
          result[parent][field] = value;
          return;
        }
      }
      result[col] = value;
    });
    return result;
  }

  // Separate WHERE conditions into DB-expressible and JS-side filters.
  // Regex values, top-level JSONB array containment, and nested JSONB array paths are
  // deferred to JS. Everything else goes to dbWhere for SQL execution.
  static splitWhere(where, $schema = null, model = null) {
    const dbWhere = {};
    const jsFilters = [];

    Object.entries(where || {}).forEach(([col, value]) => {
      const fieldMeta = ($schema && model) ? $schema(`${model}.${col}`) : null;
      const isJsonbArray = fieldMeta?.isArray;
      const isDotted = col.includes('.');

      // Detect dotted paths where the top-level column is a JSONB array.
      // e.g. 'sections.id' where 'sections' is [Section] → needs JS nested element check.
      if (isDotted) {
        const prefixEnd = col.indexOf('.');
        const prefix = col.slice(0, prefixEnd);
        const subPath = col.slice(prefixEnd + 1);
        const prefixMeta = ($schema && model) ? $schema(`${model}.${prefix}`) : null;
        if (prefixMeta?.isArray) {
          if (value instanceof RegExp) {
            jsFilters.push({ type: 'nestedField', col: prefix, path: subPath, value });
          } else if (value && typeof value === 'object' && '$in' in value) {
            jsFilters.push({ type: 'nestedFieldIn', col: prefix, path: subPath, values: value.$in });
          } else {
            jsFilters.push({ type: 'nestedField', col: prefix, path: subPath, value });
          }
          return;
        }
      }

      if (value instanceof RegExp) {
        jsFilters.push({ type: 'inList', col, values: [value] });
      } else if (Array.isArray(value)) {
        const regexes = value.filter(v => v instanceof RegExp);
        const scalars = value.filter(v => !(v instanceof RegExp));
        if (regexes.length) jsFilters.push({ type: 'inList', col, values: regexes });
        if (scalars.length) dbWhere[col] = scalars;
        else if (!regexes.length) dbWhere[col] = value; // empty array → stays for 1=0
      } else if (value && typeof value === 'object' && '$in' in value) {
        const regexes = value.$in.filter(v => v instanceof RegExp);
        const scalars = value.$in.filter(v => !(v instanceof RegExp));

        if (regexes.length) {
          // When regexes are present, use JS-side inList for ALL values.
          // Do NOT add an empty $in to dbWhere — that returns 0 rows before JS can filter.
          jsFilters.push({ type: 'inList', col, values: value.$in });
        } else if (isJsonbArray && !isDotted) {
          // Top-level JSONB array column: JS-side containment check.
          if (scalars.length) jsFilters.push({ type: 'contains', col, values: scalars });
          // empty → no filter
        } else {
          // Regular scalar: SQL IN (empty → 1=0 in buildWhereCallback).
          dbWhere[col] = { $in: scalars };
        }
      } else if (isJsonbArray && !isDotted && value !== null && value !== undefined) {
        // Top-level JSONB array, scalar value: JS-side containment.
        jsFilters.push({ type: 'contains', col, values: [value] });
      } else {
        dbWhere[col] = value;
      }
    });

    return { dbWhere, jsFilters };
  }

  // Apply deferred JS-side filters to a result row array.
  static applyJsFilters(rows, jsFilters) {
    if (!jsFilters?.length) return rows;
    return rows.filter(row =>
      jsFilters.every((filter) => {
        const { col } = filter;
        // Support dotted paths for nested JSONB values (e.g. 'building.tenants')
        const val = col.includes('.')
          ? col.split('.').reduce((obj, key) => obj?.[key], row)
          : row[col];

        if (filter.type === 'inList') {
          // OR semantics: row matches any target (regex or scalar) in the list.
          const str = Array.isArray(val) ? null : String(val ?? '');
          return filter.values.some((target) => {
            if (target instanceof RegExp) {
              if (Array.isArray(val)) return val.some(item => target.test(String(item ?? '')));
              return target.test(str);
            }
            if (Array.isArray(val)) return val.some(item => String(item ?? '').toLowerCase() === String(target ?? '').toLowerCase());
            return (str ?? '').toLowerCase() === String(target ?? '').toLowerCase();
          });
        }

        if (filter.type === 'contains') {
          if (!Array.isArray(val)) return false;
          // OR semantics: array contains at least one of the target values.
          return filter.values.some(target =>
            val.some((item) => {
              if (target instanceof RegExp) return target.test(String(item ?? ''));
              if (typeof item === 'string' && typeof target === 'string') {
                return item.toLowerCase() === target.toLowerCase();
              }
              return item == target; // eslint-disable-line eqeqeq
            }),
          );
        }

        // Nested JSONB array element: does the JSONB array column contain an element where
        // the sub-path matches the filter value?
        if (filter.type === 'nestedField') {
          const arr = row[filter.col];
          if (!Array.isArray(arr)) return false;
          const pathParts = filter.path.split('.');
          return arr.some((elem) => {
            const v = pathParts.reduce((obj, key) => obj?.[key], elem);
            if (filter.value instanceof RegExp) return filter.value.test(String(v ?? ''));
            if (typeof v === 'string' && typeof filter.value === 'string') {
              return v.toLowerCase() === filter.value.toLowerCase();
            }
            return v == filter.value; // eslint-disable-line eqeqeq
          });
        }

        if (filter.type === 'nestedFieldIn') {
          const arr = row[filter.col];
          if (!Array.isArray(arr)) return false;
          const pathParts = filter.path.split('.');
          return arr.some((elem) => {
            const v = pathParts.reduce((obj, key) => obj?.[key], elem);
            return filter.values.some((target) => {
              if (target instanceof RegExp) return target.test(String(v ?? ''));
              if (typeof v === 'string' && typeof target === 'string') {
                return v.toLowerCase() === target.toLowerCase();
              }
              return v == target; // eslint-disable-line eqeqeq
            });
          });
        }

        return true;
      }),
    );
  }

  // Serialize INSERT data: group dotted keys and JSON-stringify arrays/objects for JSONB.
  static serializeInput(data) {
    if (!data || typeof data !== 'object') return data;

    // Group dotted keys (e.g. 'section._id', 'section.name') into nested objects (one level).
    const grouped = {};
    Object.entries(data).forEach(([k, v]) => {
      const dot = k.indexOf('.');
      if (dot !== -1) {
        const prefix = k.slice(0, dot);
        const field = k.slice(dot + 1);
        grouped[prefix] = grouped[prefix] ?? {};
        grouped[prefix][field] = v;
      } else {
        grouped[k] = v;
      }
    });

    return Object.fromEntries(
      Object.entries(grouped).map(([k, v]) => {
        if (Array.isArray(v) || (v !== null && typeof v === 'object' && !(v instanceof Date))) {
          return [k, JSON.stringify(v)];
        }
        return [k, v];
      }),
    );
  }

  // Returns true if any input key targets a partial update of a non-array embedded JSONB column.
  static hasPartialJsonbUpdate(data, $schema = null, model = null) {
    if (!data || !$schema || !model) return false;
    return Object.keys(data).some((k) => {
      const dot = k.indexOf('.');
      if (dot === -1) return false;
      const prefix = k.slice(0, dot);
      const parentMeta = $schema(`${model}.${prefix}`);
      return parentMeta && !parentMeta.isArray && (parentMeta.isEmbedded || parentMeta.model);
    });
  }

  // Deep-merge partial dotted-key updates into the current row object.
  static mergePartialJsonb(current, input) {
    const result = { ...current };
    Object.entries(input).forEach(([k, v]) => {
      const dot = k.indexOf('.');
      if (dot !== -1) {
        const prefix = k.slice(0, dot);
        const field = k.slice(dot + 1);
        const existing = result[prefix];
        const base = (existing && typeof existing === 'object' && !Array.isArray(existing)) ? { ...existing } : {};
        base[field] = v;
        result[prefix] = base;
      } else {
        result[k] = v;
      }
    });
    return result;
  }

  // Build UPDATE data for knex. Dotted keys targeting a non-array embedded JSONB object
  // use jsonb_set to avoid clobbering sibling fields. All other keys use serializeInput.
  static buildUpdateData(data, $schema = null, model = null) {
    if (!data || typeof data !== 'object') return data;

    const regular = {};
    const jsonbPartialByCol = {}; // col → { subField: value }

    Object.entries(data).forEach(([k, v]) => {
      const dot = k.indexOf('.');
      if (dot !== -1) {
        const prefix = k.slice(0, dot);
        const field = k.slice(dot + 1);
        const parentMeta = ($schema && model) ? $schema(`${model}.${prefix}`) : null;
        // Use jsonb_set for partial updates of non-array embedded objects.
        if (parentMeta && !parentMeta.isArray && (parentMeta.isEmbedded || parentMeta.model)) {
          jsonbPartialByCol[prefix] = jsonbPartialByCol[prefix] || {};
          jsonbPartialByCol[prefix][field] = v;
          return;
        }
      }
      regular[k] = v;
    });

    const serialized = PostgresDriver.serializeInput(regular);

    // Build a nested jsonb_set chain for each partially-updated column.
    const jsonbUpdates = Object.fromEntries(
      Object.entries(jsonbPartialByCol).map(([col, fields]) => [
        col,
        Object.entries(fields).reduce((expr, [field, value]) => {
          const jsonVal = JSON.stringify(value === undefined ? null : value);
          return knex.raw(`jsonb_set(??, '{${field}}', ?::jsonb)`, [expr, jsonVal]);
        }, knex.raw('??', [col])),
      ]),
    );

    return { ...serialized, ...jsonbUpdates };
  }

  // Convert a regex to one or more ILIKE patterns.
  // Handles both picomatch format: ^(?:^(?:INNER)$)$ and simple ^INNER$ anchors.
  // Picomatch (used by autograph's globToRegex) uses [^/] for '?' and [^/]*? for '*'.
  // Returns array of ILIKE patterns on success, null if unconvertible.
  static regexToLike(re) {
    let src = re.source;

    // Strip picomatch double-wrapper: ^(?:^(?:INNER)$)$
    if (src.startsWith('^(?:^(?:') && src.endsWith(')$)$')) {
      src = src.slice(8, -4);
    } else if (src.startsWith('^') && src.endsWith('$')) {
      src = src.slice(1, -1);
    } else {
      return null;
    }

    return PostgresDriver.parseLikePattern(src);
  }

  // Parse a picomatch inner pattern to ILIKE form(s).
  static parseLikePattern(pattern) {
    // Strip one layer of non-capturing group (?:INNER) or capturing group (INNER)
    const isNcg = pattern.startsWith('(?:') && pattern.endsWith(')');
    const isCapt = !isNcg && pattern.startsWith('(') && pattern.endsWith(')');
    if (isNcg || isCapt) {
      const inner = isNcg ? pattern.slice(3, -1) : pattern.slice(1, -1);
      const alts = PostgresDriver.splitTopLevelPipe(inner);
      if (alts) {
        const likes = alts.map(p => PostgresDriver.picomatchSegToLike(p));
        return likes.every(l => l !== null) ? likes : null;
      }
      // Single-branch group — unwrap and continue
      return PostgresDriver.parseLikePattern(inner);
    }
    const like = PostgresDriver.picomatchSegToLike(pattern);
    return like !== null ? [like] : null;
  }

  // Split a string by top-level '|' (ignoring those inside () or []).
  static splitTopLevelPipe(s) {
    const parts = [];
    let depth = 0;
    let cur = '';
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '(' || c === '[') depth++;
      else if (c === ')' || c === ']') depth--;
      else if (c === '|' && depth === 0) { parts.push(cur); cur = ''; continue; }
      cur += c;
    }
    parts.push(cur);
    return parts.length > 1 ? parts : null;
  }

  // Convert a single picomatch regex segment to a SQL LIKE pattern.
  // Handles: [^/] → _, [^/]*? → %, lookaheads → skipped, \/ → skipped, \X → X.
  static picomatchSegToLike(pattern) {
    let like = '';
    let i = 0;
    while (i < pattern.length) {
      if (pattern[i] === '[') {
        const end = pattern.indexOf(']', i);
        if (end === -1) return null;
        let qi = end + 1;
        let quantifier = '';
        while (qi < pattern.length && '*+?'.includes(pattern[qi])) { quantifier += pattern[qi]; qi++; }
        like += (quantifier.includes('*') || quantifier.includes('+')) ? '%' : '_';
        i = qi;
      } else if (pattern[i] === '(' && i + 1 < pattern.length && pattern[i + 1] === '?') {
        // Lookahead/lookbehind assertion (?!...) (?=...) — skip the entire group
        let depth = 1;
        let j = i + 1;
        while (j < pattern.length && depth > 0) {
          if (pattern[j] === '(') depth++;
          else if (pattern[j] === ')') depth--;
          j++;
        }
        i = j;
      } else if (pattern[i] === '.' && i + 1 < pattern.length && '*?+'.includes(pattern[i + 1])) {
        like += '%'; i += 2;
        while (i < pattern.length && '*?+'.includes(pattern[i])) i++;
      } else if (pattern[i] === '\\' && i + 1 < pattern.length) {
        const next = pattern[i + 1];
        if (next === '/') {
          // \/ — optional path separator picomatch appends; skip it and any trailing ?
          i += 2;
          if (i < pattern.length && pattern[i] === '?') i++;
        } else {
          like += next; i += 2;
        }
      } else if ('()|*+?'.includes(pattern[i])) {
        return null; // Unhandled metachar
      } else {
        like += pattern[i]; i++;
      }
    }
    return like;
  }

  // Build a knex WHERE callback from a flat where object.
  // joinedTables: known JOIN aliases; dotted keys starting with these use table.col syntax.
  // $schema / model: field metadata for JSONB array detection.
  // mainTable: qualifies unqualified columns to avoid ambiguity when JOINs are present.
  static buildWhereCallback(where, joinedTables = new Set(), $schema = null, model = null, mainTable = null) {
    return function () {
      Object.entries(where || {}).forEach(([col, value]) => {
        let colExpr;
        let jsonbContainerExpr = null; // JSONB extract (->) for @> containment (not ->>'s text)
        let isJsonbPath = false;

        const dotPos = col.indexOf('.');
        if (dotPos !== -1) {
          const prefix = col.slice(0, dotPos);
          const field = col.slice(dotPos + 1);
          if (joinedTables.has(prefix)) {
            colExpr = `"${prefix}"."${field}"`;
          } else {
            colExpr = `"${prefix}"->>'${field}'`; // TEXT extraction
            jsonbContainerExpr = `("${prefix}"->'${field}')`; // JSONB extraction for @>
            isJsonbPath = true;
          }
        } else if (mainTable && joinedTables.size > 0) {
          colExpr = `"${mainTable}"."${col}"`;
        } else {
          colExpr = `"${col}"`;
        }

        // Resolve field metadata — supports dotted paths (e.g. building.tenants)
        const fieldMeta = ($schema && model) ? $schema(`${model}.${col}`) : null;
        const isJsonbArray = fieldMeta?.isArray;

        if (value === undefined) {
          this.whereRaw('1 = 0');
        } else if (value === null) {
          this.whereRaw(`${colExpr} IS NULL`);
        } else if (value instanceof RegExp) {
          // Convert glob-derived regex to ILIKE for SQL execution (join WHERE conditions).
          const likePatterns = PostgresDriver.regexToLike(value);
          if (likePatterns?.length === 1) {
            this.whereRaw(`${colExpr} ILIKE ?`, [likePatterns[0]]);
          } else if (likePatterns?.length > 1) {
            const ors = likePatterns.map(() => `${colExpr} ILIKE ?`).join(' OR ');
            this.whereRaw(`(${ors})`, likePatterns);
          }
          // else: skip unconvertible pattern (over-fetch; acceptable for non-critical paths)
        } else if (Array.isArray(value)) {
          if (value.length) {
            if (value.every(v => typeof v === 'string')) {
              this.whereRaw(`LOWER(${colExpr}) IN (${value.map(() => 'LOWER(?)').join(', ')})`, value);
            } else {
              this.whereRaw(`${colExpr} IN (${value.map(() => '?').join(', ')})`, value);
            }
          } else this.whereRaw('1 = 0');
        } else if (value && typeof value === 'object' && '$in' in value) {
          const vals = value.$in;
          if (isJsonbArray || jsonbContainerExpr) {
            // JSONB array containment: use @> with the JSONB expression.
            const expr = jsonbContainerExpr || colExpr;
            if (vals.length) this.whereRaw(`${expr} @> ?::jsonb`, [JSON.stringify(vals)]);
            else this.whereRaw('1 = 0');
          } else if (vals.length) {
            const strings = vals.filter(v => typeof v === 'string');
            const regexes = vals.filter(v => v instanceof RegExp);
            const others = vals.filter(v => typeof v !== 'string' && !(v instanceof RegExp));
            const parts = [];
            const bindings = [];
            if (strings.length) {
              parts.push(`LOWER(${colExpr}) IN (${strings.map(() => 'LOWER(?)').join(', ')})`);
              bindings.push(...strings);
            }
            for (const re of regexes) {
              const likes = PostgresDriver.regexToLike(re);
              if (likes?.length === 1) { parts.push(`${colExpr} ILIKE ?`); bindings.push(likes[0]); }
              else if (likes?.length > 1) { parts.push(`(${likes.map(() => `${colExpr} ILIKE ?`).join(' OR ')})`); bindings.push(...likes); }
            }
            if (others.length) {
              parts.push(`${colExpr} IN (${others.map(() => '?').join(', ')})`);
              bindings.push(...others);
            }
            if (parts.length) this.whereRaw(`(${parts.join(' OR ')})`, bindings);
            else this.whereRaw('1 = 0');
          } else {
            this.whereRaw('1 = 0');
          }
        } else if (value && typeof value === 'object' && '$ne' in value) {
          const neVal = value.$ne;
          if (neVal === null) {
            this.whereRaw(`${colExpr} IS NOT NULL`);
          } else if (typeof neVal === 'string') {
            this.whereRaw(`LOWER(${colExpr}) != LOWER(?)`, [neVal]);
          } else {
            this.whereRaw(`${colExpr} != ?`, [neVal]);
          }
        } else if (isJsonbArray) {
          // Scalar containment on a JSONB array column (top-level or nested).
          const expr = jsonbContainerExpr || colExpr;
          this.whereRaw(`${expr} @> ?::jsonb`, [JSON.stringify([value])]);
        } else if (typeof value === 'string' || isJsonbPath) {
          // Case-insensitive string equality (mirrors MongoDB collation strength:2).
          this.whereRaw(`LOWER(${colExpr}) = LOWER(?)`, [String(value)]);
        } else {
          this.whereRaw(`${colExpr} = ?`, [value]);
        }
      });
    };
  }

  static buildSelect(query, count = false, arrayJoins = null) {
    const { model, select, where, sort = {}, skip, limit, joins, after, before, first } = query;

    let q = knex(model);
    const joinedTables = new Set();
    const seenTables = new Map();

    const flatSort = Object.entries(Util.flatten(sort, { safe: true }));
    const hasJoinSort = flatSort.some(([k]) => k.startsWith('join_'));

    if (joins?.length) {
      // Pre-register the main table so recursive applyJoins can detect all circular references.
      joinedTables.add(model);
      PostgresDriver.applyJoins(q, model, joins, joinedTables, seenTables, query.$schema, arrayJoins);
      if (!hasJoinSort) {
        q = q.distinct(`${model}.*`);
      } else {
        // Can't use DISTINCT when ORDER BY uses a joined column not in SELECT.
        // Select only the main table to avoid PK column clashes; deduplication happens in JS.
        q = q.select(`${model}.*`);
      }
    }

    q = q.where(PostgresDriver.buildWhereCallback(
      where, joinedTables, query.$schema, model, joins?.length ? model : null,
    ));

    if (count) return q.clearSelect().count('* as count');

    if (select?.length && !joins?.length) {
      const cols = query.$schema
        ? select.filter(col => !query.$schema(`${model}.${col}`)?.isVirtual)
        : select;
      if (cols.length) q = q.select(cols.map(col => `${model}.${col}`));
    }

    if (flatSort.length) {
      flatSort.forEach(([col, rawDir]) => {
        const sqlDir = (rawDir === 'asc' || rawDir === 1 || rawDir === '1') ? 'asc' : 'desc';

        if (col.startsWith('join_')) {
          // Multi-level join_ chain: 'join_Book.join_Chapter.chapter_name'
          // Strip all join_ prefixes to find the final table and field.
          const parts = col.split('.');
          const joinParts = parts.filter(p => p.startsWith('join_')).map(p => p.slice('join_'.length));
          const fieldParts = parts.filter(p => !p.startsWith('join_'));
          if (joinParts.length && fieldParts.length) {
            const lastTable = joinParts[joinParts.length - 1];
            const field = fieldParts.join('.');
            q = q.orderByRaw(`"${lastTable}"."${field}" ${sqlDir}`);
          }
        } else {
          const fieldMeta = query.$schema ? query.$schema(`${model}.${col}`) : null;
          const isString = !fieldMeta || fieldMeta.type === 'String' || fieldMeta.type === 'ID' || fieldMeta.type === undefined;
          if (isString) {
            q = q.orderByRaw(`LOWER("${col}") ${sqlDir}`);
          } else {
            q = q.orderBy(col, sqlDir);
          }
        }
      });
    }

    if (skip) q = q.offset(skip);
    if (limit) q = q.limit(limit);
    if (first) q = q.limit(first);

    if (after) {
      Object.entries(after).forEach(([col, val]) => {
        q = q.where(col, sort[col] === 'asc' ? '>=' : '<=', val);
      });
    }
    if (before) {
      Object.entries(before).forEach(([col, val]) => {
        q = q.where(col, sort[col] === 'asc' ? '<=' : '>=', val);
      });
    }

    return q;
  }

  static applyJoins(q, mainTable, joins, joinedTables = new Set(), seenTables = new Map(), $schema = null, arrayJoins = null) {
    joins.forEach((join) => {
      let { to, on: foreignField, from: localField, where: joinWhere, children } = join;

      // Dotted localField: multi-hop path like "sections.person" or "section.person".
      // If the FIRST component is a JSONB array column → collect as embeddedArray (JS-side).
      // If the FIRST component is an embedded JSONB object → use ->> extraction in ON clause.
      // Otherwise → use only the last component (FK chain from parent context).
      let jsonbOnExpr = null; // Non-null when the ON condition needs JSONB path extraction.
      if (typeof localField === 'string' && localField.includes('.')) {
        const parts = localField.split('.');
        const firstComp = parts[0];
        const firstMeta = $schema ? $schema(`${mainTable}.${firstComp}`) : null;
        if (firstMeta?.isArray) {
          // Embedded JSONB array path (e.g. Art.sections.person)
          if (arrayJoins) {
            arrayJoins.push({
              type: 'embeddedArray',
              mainTable,
              arrayCol: firstComp,
              elemFk: parts.slice(1).join('.'),
              to,
              pkCol: foreignField,
              joinWhere: joinWhere || {},
              children: children || [],
              $schema,
            });
          }
          return;
        }
        if (firstMeta?.isEmbedded) {
          // Embedded JSONB object (e.g. Person.section.person).
          // Build a ->> path expression to extract the FK from the JSONB column.
          const restParts = parts.slice(1);
          let expr = `"${mainTable}"."${firstComp}"`;
          restParts.slice(0, -1).forEach(p => { expr += `->'${p}'`; });
          expr += `->>'${restParts[restParts.length - 1]}'`;
          jsonbOnExpr = expr;
        }
        // Fall through with last component for alias/lookup (not used in SQL when jsonbOnExpr is set).
        localField = parts[parts.length - 1];
      }

      // JSONB array FK column (e.g. Person.friends: [Person]) — collect for JS-side resolution.
      // Set-returning functions (jsonb_array_elements*) are not universally supported.
      const localFieldMeta = $schema ? $schema(`${mainTable}.${localField}`) : null;
      if (localFieldMeta?.isArray) {
        if (arrayJoins) {
          arrayJoins.push({
            type: 'directArray',
            mainTable,
            localField,
            to,
            pkCol: foreignField,
            joinWhere: joinWhere || {},
            children: children || [],
            $schema,
          });
        }
        return;
      }

      // Alias circular/duplicate table joins to avoid ambiguous column references.
      let alias = to;
      if (joinedTables.has(to)) {
        const count = (seenTables.get(to) || 0) + 1;
        seenTables.set(to, count);
        alias = `${to}_${count}`;
      }

      joinedTables.add(alias);

      // Use INNER JOIN: rows with no matching join record are excluded, matching MongoDB $unwind.
      if (alias !== to) {
        if (jsonbOnExpr) {
          q.join(knex.raw(`"${to}" AS "${alias}"`), knex.raw(`"${alias}"."${foreignField}" = (${jsonbOnExpr})`));
        } else {
          q.join(knex.raw(`"${to}" AS "${alias}"`), `${alias}.${foreignField}`, `${mainTable}.${localField}`);
        }
      } else if (jsonbOnExpr) {
        q.join(to, knex.raw(`"${to}"."${foreignField}" = (${jsonbOnExpr})`));
      } else {
        q.join(to, `${to}.${foreignField}`, `${mainTable}.${localField}`);
      }

      if (joinWhere && Object.keys(joinWhere).length) {
        const prefixed = Object.fromEntries(
          Object.entries(joinWhere).map(([k, v]) => [`${alias}.${k}`, v]),
        );
        q.where(PostgresDriver.buildWhereCallback(prefixed, joinedTables));
      }

      if (children?.length) PostgresDriver.applyJoins(q, alias, children, joinedTables, seenTables, $schema, arrayJoins);
    });
  }
};
