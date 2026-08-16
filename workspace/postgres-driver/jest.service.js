const { newDb } = require('pg-mem');
const { setup, createObjectIdShim, instrumentClient } = require('@coderich/autograph-db-tests');
const { wrapPool } = require('./test/PgMemShim');
const PostgresDriver = require('./src/PostgresDriver');

// Map autograph field metadata to a Postgres column type.
function fieldToSqlType(field) {
  if (field.isArray || (field.isEmbedded && field.model)) return 'JSONB';
  switch (field.type) {
    case 'Int': return 'INTEGER';
    case 'Float': return 'NUMERIC';
    case 'Boolean': return 'BOOLEAN';
    case 'Date': return 'TIMESTAMPTZ';
    case 'AutoGraphMixed': return 'JSONB';
    default: return 'TEXT'; // String, ID, enum refs, FK references
  }
}

// Generate CREATE TABLE statements from parsed autograph models.
function buildDDL(models) {
  return Object.values(models)
    .filter(m => m.isMarkedModel && !m.isEmbedded)
    .map((model) => {
      const cols = Object.values(model.fields)
        .filter(f => !f.isVirtual)
        .map((field) => {
          const type = fieldToSqlType(field);
          const pk = field.isPrimaryKey ? ' PRIMARY KEY' : '';
          return `"${field.key}" ${type}${pk}`;
        });
      return `CREATE TABLE IF NOT EXISTS "${model.key}" (${cols.join(', ')})`;
    });
}

exports.setup = async () => {
  const pgMem = newDb();

  // pg-mem ships very few native functions; the driver's $size translation uses these two REAL
  // Postgres builtins, so the harness supplies faithful implementations. char_length counts
  // CHARACTERS (code points) — [...str].length, never str.length (UTF-16 units).
  pgMem.public.registerFunction({
    name: 'jsonb_array_length',
    args: ['jsonb'],
    returns: 'integer',
    implementation: v => (Array.isArray(v) ? v.length : null),
  });
  pgMem.public.registerFunction({
    name: 'char_length',
    args: ['text'],
    returns: 'integer',
    implementation: v => (v == null ? null : [...String(v)].length),
  });

  const { Pool } = pgMem.adapters.createPg();
  // The production driver is written against REAL Postgres semantics (native isolation and
  // rollback); pg-mem has neither, so the test pool is wrapped in an emulation shim.
  const pool = wrapPool(new Pool());

  // ObjectId shim: IDs are plain strings; Symbol.hasInstance override makes
  // `expect.any(ObjectId)` pass for non-empty strings. See testsuite/index.js.
  global.ObjectId = createObjectIdShim();

  global.postgresClient = new PostgresDriver({ pool });

  // Alias mongoClient so the DataLoader spy test can find the client.
  global.mongoClient = global.postgresClient;

  const { client: instrumentedClient, calls } = instrumentClient(global.postgresClient);
  global.driverCalls = calls;

  // Monotonically increasing sequential ID counter.
  // Sequential IDs ensure that entities created earlier always sort before later ones,
  // matching the ordering semantics the shared TestSuite was written for (MongoDB ObjectIds).
  let idSeq = 0;
  function nextId() {
    const n = ++idSeq;
    const hex = n.toString(16).padStart(32, '0');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  // Raw table accessor for the TestSuite's "Driver Queries" verification — a TEST-HARNESS
  // concern (bypasses autograph entirely), not a production API. Provides the documented
  // findOne/find/findOneAndUpdate surface over raw SQL.
  const eq = (where = {}) => {
    const cols = Object.keys(where);
    const sql = cols.length ? ` WHERE ${cols.map((c, i) => `"${c}" = $${i + 1}`).join(' AND ')}` : '';
    return { sql, params: cols.map(c => where[c]) };
  };
  global.rawDriver = table => ({
    findOne: async (where) => {
      const { sql, params } = eq(where);
      const r = await pool.query(`SELECT * FROM "${table}"${sql} LIMIT 1`, params);
      return r.rows[0] ? PostgresDriver.reviveRow(r.rows[0]) : null;
    },
    find: async (where) => {
      const { sql, params } = eq(where);
      const r = await pool.query(`SELECT * FROM "${table}"${sql}`, params);
      const rows = r.rows.map(PostgresDriver.reviveRow);
      return { toArray: () => Promise.resolve(rows) };
    },
    findOneAndUpdate: async (where, update) => {
      const patch = PostgresDriver.serializeInput(update.$set || update);
      const cols = Object.keys(patch);
      const { sql, params } = eq(where);
      const sets = cols.map((c, i) => `"${c}" = $${params.length + i + 1}`).join(', ');
      const r = await pool.query(`UPDATE "${table}" SET ${sets}${sql} RETURNING *`, [...params, ...cols.map(c => patch[c])]);
      return r.rows[0] ? PostgresDriver.reviveRow(r.rows[0]) : null;
    },
  });

  // Build schema + resolver (no DB calls yet)
  const result = setup({
    generator: ({ value }) => {
      // Unwrap real ObjectId instances to their plain string; generate new IDs as plain strings.
      if (value && typeof value === 'object' && '_id' in value) return value._id;
      return value || nextId();
    },
    dataSource: {
      supports: ['transactions', 'joins'],
      client: instrumentedClient,
    },
  });
  Object.assign(global, result);

  const parsed = global.schema.parse();

  // Create tables
  for (const ddl of buildDDL(parsed.models)) {
    await pool.query(ddl); // eslint-disable-line no-await-in-loop
  }

  // Create indexes
  await Promise.all(parsed.indexes.map(({ key, name, type, on }) => {
    const cols = on.map(c => `"${c}"`).join(', ');
    const unique = type === 'unique' ? 'UNIQUE ' : '';
    return pool.query(`CREATE ${unique}INDEX IF NOT EXISTS "${name}" ON "${key}" (${cols})`);
  }));
};
