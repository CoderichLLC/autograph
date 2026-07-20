const { Neo4jContainer } = require('@testcontainers/neo4j');
const neo4j = require('neo4j-driver');
const { setup, createObjectIdShim, instrumentClient } = require('@coderich/autograph-db-tests');
const Neo4jDriver = require('./src/Neo4jDriver');

exports.setup = async () => {
  // Live Neo4j via Docker. If a schema index turns out to need Enterprise (composite
  // uniqueness), switch the image to 'neo4j:5-enterprise' and add
  // .withEnvironment({ NEO4J_ACCEPT_LICENSE_AGREEMENT: 'eval' }).
  global.neo4jContainer = await new Neo4jContainer('neo4j:5.26').withPassword('autograph').start();

  global.boltDriver = neo4j.driver(
    global.neo4jContainer.getBoltUri(),
    neo4j.auth.basic(global.neo4jContainer.getUsername(), global.neo4jContainer.getPassword()),
    { disableLosslessIntegers: true }, // plain JS numbers, not neo4j Integer objects
  );

  // ObjectId shim: IDs are plain strings; Symbol.hasInstance override makes
  // `expect.any(ObjectId)` pass for non-empty strings. See testsuite/index.js.
  global.ObjectId = createObjectIdShim();

  global.neo4jClient = new Neo4jDriver({ driver: global.boltDriver });

  // Alias mongoClient so the DataLoader spy test can find the client (postgres does the same).
  global.mongoClient = global.neo4jClient;

  const { client: instrumentedClient, calls } = instrumentClient(global.neo4jClient);
  global.driverCalls = calls;

  // Monotonically increasing sequential ID counter — TestSuite ordering assumes IDs sort in
  // creation order (see autograph CLAUDE.md "ID generation and sort order").
  let idSeq = 0;
  function nextId() {
    const hex = (++idSeq).toString(16).padStart(32, '0');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  // Raw table accessor for the TestSuite's "Driver Queries" verification — a TEST-HARNESS
  // concern (bypasses autograph entirely), not a production API. Uses the RAW bolt driver
  // (not the instrumented client) like mongo/postgres do.
  const run = async (cypher, params) => {
    const session = global.boltDriver.session();
    try { return (await session.run(cypher, params)).records; } finally { await session.close(); }
  };
  const eq = (where = {}) => {
    const keys = Object.keys(where);
    const frag = keys.length ? ` WHERE ${keys.map(k => `n.\`${k}\` = $${k}`).join(' AND ')}` : '';
    return { frag, params: where };
  };
  global.rawDriver = label => ({
    findOne: async (where) => {
      const { frag, params } = eq(where);
      const records = await run(`MATCH (n:\`${label}\`)${frag} RETURN n LIMIT 1`, params);
      return records[0] ? Neo4jDriver.reviveRow(records[0].get('n').properties) : null;
    },
    // Returns a mongo-style cursor ({ toArray }) — the TestSuite's "Driver Queries" section calls
    // `.find().then(cursor => cursor.toArray())`, mirroring the MongoDB raw-accessor shape.
    find: async (where) => {
      const { frag, params } = eq(where);
      const records = await run(`MATCH (n:\`${label}\`)${frag} RETURN n`, params);
      const rows = records.map(r => Neo4jDriver.reviveRow(r.get('n').properties));
      return { toArray: async () => rows };
    },
    findOneAndUpdate: async (where, update) => {
      const { frag, params } = eq(where);
      const records = await run(
        `MATCH (n:\`${label}\`)${frag} WITH n LIMIT 1 SET n += $__props RETURN n`,
        { ...params, __props: update },
      );
      return records[0] ? Neo4jDriver.reviveRow(records[0].get('n').properties) : null;
    },
  });

  // Autograph
  Object.assign(global, setup({
    generator: ({ value }) => value ?? nextId(),
    dataSource: {
      supports: ['transactions'], // 'spatial' is added in Task 6
      client: instrumentedClient,
    },
  }));

  // Indexes: unique constraints from the parsed schema (POINT INDEX DDL is added in Task 6).
  // Sequential, not Promise.all: concurrent CREATE CONSTRAINT statements race Neo4j's Forseti
  // lock manager (UpdateLock on the schema label) and intermittently deadlock.
  const uniqueIndexes = global.schema.parse().indexes.filter(({ type }) => type === 'unique');
  for (const { name, key, on } of uniqueIndexes) {
    const props = on.map(f => `n.\`${f}\``).join(', ');
    await run(`CREATE CONSTRAINT \`${name}\` IF NOT EXISTS FOR (n:\`${key}\`) REQUIRE (${props}) IS UNIQUE`, {}); // eslint-disable-line no-await-in-loop
  }
};
