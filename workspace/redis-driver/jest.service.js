const { RedisMemoryServer } = require('redis-memory-server');
const Redis = require('ioredis');
const { setup, createObjectIdShim } = require('@coderich/autograph-db-tests');
const RedisDriver = require('./src/RedisDriver');

exports.setup = async () => {
  // A REAL redis-server binary, in memory — no emulation shim of any kind (Redis is already
  // an in-memory store; we test real semantics, unlike pg-mem's emulated transactions).
  const server = new RedisMemoryServer();
  const host = await server.getHost();
  const port = await server.getPort();
  global.redisMemoryServer = server;

  const client = new Redis({ host, port, lazyConnect: false });
  global.redisIoClient = client;

  // ObjectId shim: IDs are plain strings; Symbol.hasInstance override makes
  // `expect.any(ObjectId)` pass for non-empty strings. See testsuite/index.js.
  global.ObjectId = createObjectIdShim();

  global.redisClient = new RedisDriver({ client });

  // Alias mongoClient so the DataLoader spy test can find the client.
  global.mongoClient = global.redisClient;

  // Monotonically increasing sequential ID counter — entities created earlier must always
  // sort before later ones (the ordering semantics the shared TestSuite was written for).
  let idSeq = 0;
  function nextId() {
    const n = ++idSeq;
    const hex = n.toString(16).padStart(32, '0');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  // Raw table accessor for the TestSuite's "Driver Queries" verification — a TEST-HARNESS
  // concern (bypasses autograph AND the driver's index maintenance), not a production API.
  // Equality here is STRICT and case-sensitive (raw storage verification, no contract sugar).
  const scan = async (table) => {
    const ids = await client.smembers(`${table}:__ids`);
    if (!ids.length) return [];
    ids.sort();
    const blobs = await client.mget(ids.map(id => `${table}:${id}`));
    return blobs.filter(Boolean).map(blob => RedisDriver.revive(JSON.parse(blob)));
  };
  const matches = (row, where = {}) => Object.entries(where).every(([k, v]) => {
    const value = row[k];
    return String(value) === String(v) && (value == null) === (v == null);
  });
  global.rawDriver = table => ({
    findOne: async (where = {}) => (await scan(table)).find(row => matches(row, where)) ?? null,
    find: async (where = {}) => {
      const rows = (await scan(table)).filter(row => matches(row, where));
      return { toArray: () => Promise.resolve(rows) };
    },
    findOneAndUpdate: async (where = {}, update = {}) => {
      const row = (await scan(table)).find(r => matches(r, where));
      if (!row) return null;
      const merged = RedisDriver.normalize(RedisDriver.applyInput(row, update.$set || update));
      await client.set(`${table}:${merged._id}`, JSON.stringify(merged));
      return merged;
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
      supports: [], // the whole point: no transactions, no joins — the framework carries both
      client: global.redisClient,
    },
  });
  Object.assign(global, result);

  // DDL analog: register unique indexes with the driver (the deployment step every other
  // driver performs against its engine; Redis IS the engine here).
  const parsed = global.schema.parse();
  global.redisClient.applyIndexes(parsed.indexes);
};
