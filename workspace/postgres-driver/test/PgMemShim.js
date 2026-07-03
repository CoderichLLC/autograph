/**
 * pg-mem transaction-isolation shim — TEST HARNESS ONLY.
 *
 * pg-mem is not a real Postgres: writes are immediately visible to every connection (no
 * isolation), and ROLLBACK does not undo anything. The production PostgresDriver is written
 * against REAL Postgres semantics (BEGIN ISOLATION LEVEL REPEATABLE READ → native snapshot
 * isolation; ROLLBACK → native rollback) and knows nothing about pg-mem — so this shim
 * monkey-patches the pg-mem adapter's Pool to EMULATE those semantics at the one choke point
 * every query passes through (`pool.query` / `client.query`):
 *
 *   - BEGIN* is rewritten to plain BEGIN (pg-mem doesn't parse isolation levels) and opens a
 *     per-connection emulation context: a snapshot of IDs pending in other transactions
 *     (`exclusions`) plus its own pending-insert ledger.
 *   - INSERT INTO "Model" ... RETURNING inside a transaction records the returned _id(s) so
 *     ROLLBACK can manually DELETE them (pg-mem rollback is a no-op) and so other connections
 *     can hide them while they're uncommitted.
 *   - SELECT results are filtered: sessionless reads hide ALL pending IDs; in-transaction reads
 *     see their own pending writes, and keep hiding IDs that were pending at snapshot time or
 *     committed by other transactions after it (`postSnapshotIds`) — REPEATABLE READ emulation.
 *   - COMMIT propagates this transaction's IDs into every still-open context's
 *     `postSnapshotIds` (they pre-date those snapshots and must stay hidden from them).
 *   - UPDATE/DELETE inside a transaction capture PRE-IMAGES first (a SELECT of the affected
 *     rows, first-capture-wins = state at transaction start); ROLLBACK restores them
 *     (delete-and-reinsert), emulating real rollback for in-place mutations — this is what lets
 *     "delete rolls back cascades when a restrict throws mid-walk" pass under pg-mem.
 *
 * Parsing note: pre-image capture works by pattern-matching the SQL knex generates
 * (`update "T" set ... where ...` / `delete from "T" where ...`) — regular by construction
 * since the driver builds all mutation SQL through knex.
 */

const INSERT_RE = /^\s*insert\s+into\s+"([^"]+)"/i;
const UPDATE_RE = /^\s*update\s+"([^"]+)"\s+set\s+(.*?)\s+where\s+(.*)$/is;
const DELETE_RE = /^\s*delete\s+from\s+"([^"]+)"(?:\s+where\s+(.*))?$/is;
const SELECT_RE = /^\s*select/i;
const BEGIN_RE = /^\s*begin/i;
const COMMIT_RE = /^\s*commit/i;
const ROLLBACK_RE = /^\s*rollback/i;

exports.wrapPool = (pool) => {
  const allPendingIds = new Set();
  const txnContexts = new Set();

  // Filter SELECT rows per emulated isolation semantics. `ctx` is null for sessionless reads.
  const filterRows = (result, ctx) => {
    if (!result?.rows?.length) return result;
    // A context's exclusions/postSnapshotIds must keep hiding their IDs for the context's whole
    // lifetime — even after the global pending set empties because the excluded write elsewhere
    // has committed (see TestSuite "multi txn (isolated snapshots)").
    const hasOwnExclusions = ctx && (ctx.exclusions.size > 0 || ctx.postSnapshotIds.size > 0);
    if (allPendingIds.size === 0 && !hasOwnExclusions) return result;
    const rows = result.rows.filter((row) => {
      const id = row._id;
      if (!id) return true;
      if (!ctx) return !allPendingIds.has(id);
      if (ctx.ownPending.has(id)) return true;
      if (ctx.exclusions.has(id)) return false;
      if (ctx.postSnapshotIds.has(id)) return false;
      for (const other of txnContexts) {
        if (other !== ctx && other.ownPending.has(id)) return false;
      }
      return true;
    });
    return { ...result, rows, rowCount: rows.length };
  };

  // pg-mem's adapter `client.query` delegates internally to `pool.query` — i.e., to the patched
  // version below. Without a guard, a transaction-client SELECT would be filtered TWICE: first
  // here with the sessionless rules (hiding the transaction's own pending rows), then at the
  // client wrapper with the correct context. The client wrapper raises this flag around its
  // (synchronous) delegation into rawQuery, so the pool-level filter stands down for that call.
  // Synchronous set/capture/clear — no await in the window — so interleaved transactions can't
  // race it.
  let inClientCall = false;

  const rawPoolQuery = pool.query.bind(pool);
  pool.query = (...args) => {
    const delegated = inClientCall;
    return rawPoolQuery(...args).then((result) => {
      return (!delegated && SELECT_RE.test(String(args[0]))) ? filterRows(result, null) : result;
    });
  };

  const rawConnect = pool.connect.bind(pool);
  pool.connect = (...connectArgs) => Promise.resolve(rawConnect(...connectArgs)).then((client) => {
    const rawQuery = client.query.bind(client);
    // Invoke the raw client query with the pool-filter guard raised for the SYNCHRONOUS window
    // in which the adapter delegates into (patched) pool.query.
    const run = (...args) => {
      inClientCall = true;
      try {
        return rawQuery(...args);
      } finally {
        inClientCall = false;
      }
    };
    let ctx = null;

    return {
      query: async (sql, ...rest) => {
        const text = String(sql);

        if (BEGIN_RE.test(text)) {
          ctx = {
            ownPending: new Set(),
            ownPendingByModel: new Map(),
            exclusions: new Set(allPendingIds), // snapshot: pending elsewhere at txn start
            postSnapshotIds: new Set(), // committed elsewhere after txn start
            preImages: new Map(), // `table\0id` -> { table, row } — txn-start state of mutated rows
          };
          txnContexts.add(ctx);
          return run('BEGIN'); // strip any isolation-level clause pg-mem can't parse
        }

        if (COMMIT_RE.test(text) || ROLLBACK_RE.test(text)) {
          const isRollback = ROLLBACK_RE.test(text);
          if (ctx) {
            if (isRollback) {
              // pg-mem rollback is a no-op — manually delete the rows this txn inserted...
              for (const [model, ids] of ctx.ownPendingByModel) {
                if (ids.size > 0) {
                  const placeholders = [...ids].map((_, i) => `$${i + 1}`).join(', ');
                  await rawPoolQuery(`DELETE FROM "${model}" WHERE "_id" IN (${placeholders})`, [...ids]); // eslint-disable-line no-await-in-loop
                }
              }
              // ...and restore the pre-images of every row it updated or deleted.
              for (const { table, row } of ctx.preImages.values()) {
                const cols = Object.keys(row);
                const values = cols.map((col) => {
                  const v = row[col];
                  if (v === null || v === undefined) return null;
                  if (Array.isArray(v) || (typeof v === 'object' && !(v instanceof Date))) return JSON.stringify(v);
                  return v;
                });
                /* eslint-disable no-await-in-loop */
                await rawPoolQuery(`DELETE FROM "${table}" WHERE "_id" = $1`, [row._id]);
                await rawPoolQuery(
                  `INSERT INTO "${table}" (${cols.map(c => `"${c}"`).join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
                  values,
                );
                /* eslint-enable no-await-in-loop */
              }
            } else {
              // Committed IDs post-date every other open snapshot — keep hiding them there.
              for (const other of txnContexts) {
                if (other !== ctx) for (const id of ctx.ownPending) other.postSnapshotIds.add(id);
              }
            }
            for (const id of ctx.ownPending) allPendingIds.delete(id);
            txnContexts.delete(ctx);
            ctx = null;
          }
          return run(isRollback ? 'ROLLBACK' : 'COMMIT');
        }

        // PRE-IMAGE capture: before an in-transaction UPDATE/DELETE executes, snapshot the
        // rows it will touch so ROLLBACK can restore them. First capture per row wins (= the
        // row's state at transaction start); rows this txn itself inserted are skipped (their
        // rollback is deletion).
        if (ctx) {
          const params = rest[0] || [];
          const update = text.match(UPDATE_RE);
          const del = update ? null : text.match(DELETE_RE);
          if (update || del) {
            const table = (update || del)[1];
            let selectSql;
            let selectParams;
            // knex mutations may end with a RETURNING clause — not part of the WHERE.
            const stripReturning = seg => seg.replace(/\s+returning\s+[^)]*$/i, '');
            if (update) {
              const setCount = (update[2].match(/\$\d+/g) || []).length;
              const where = stripReturning(update[3]).replace(/\$(\d+)/g, (m, n) => `$${Number(n) - setCount}`);
              selectSql = `SELECT * FROM "${table}" WHERE ${where}`;
              selectParams = params.slice(setCount);
            } else {
              const where = del[2] ? stripReturning(del[2]) : null;
              selectSql = where ? `SELECT * FROM "${table}" WHERE ${where}` : `SELECT * FROM "${table}"`;
              selectParams = where ? params : [];
            }
            const affected = await run(selectSql, selectParams);
            for (const row of affected?.rows ?? []) {
              const key = `${table}\u0000${row._id}`;
              if (row._id && !ctx.ownPending.has(row._id) && !ctx.preImages.has(key)) {
                ctx.preImages.set(key, { table, row });
              }
            }
          }
        }

        const result = await run(sql, ...rest);

        if (ctx) {
          const insert = text.match(INSERT_RE);
          if (insert && result?.rows) {
            for (const row of result.rows) {
              const id = row._id;
              if (id) {
                ctx.ownPending.add(id);
                allPendingIds.add(id);
                if (!ctx.ownPendingByModel.has(insert[1])) ctx.ownPendingByModel.set(insert[1], new Set());
                ctx.ownPendingByModel.get(insert[1]).add(id);
              }
            }
          }
          if (SELECT_RE.test(text)) return filterRows(result, ctx);
        }

        return result;
      },
      release: (...args) => client.release(...args),
    };
  });

  return pool;
};
