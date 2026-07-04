'use strict';

/**
 * `supports` capability fallbacks — consumer-declared, honored, never thrown (with one loud edge).
 *
 * The data source here is a fully-capable MongoDB driver whose source deliberately declares
 * `supports: []` — the consumer's statement that AG must not use driver joins or transactions.
 *
 *   - joins:        every join-shaped where/sort rides QueryPlanner's pre-query/$in + in-memory
 *                   sort pipeline; the driver NEVER receives query.joins (spy-asserted). WHERE
 *                   lifts cover FK sub-paths (both link directions), embedded-prefix stored FKs,
 *                   and bare virtual equality. The loud edges: join-shaped SORT deeper than a
 *                   first-segment FK (multi-valued — ill-defined), and WHERE on a virtual link
 *                   behind an embedded prefix (no local column) — reject, never over-match.
 *   - transactions: scopes are inert for the source — writes dispatch sessionless and are
 *                   durable when awaited (uncarried semantics); commit() is meaningless and
 *                   rollback() CANNOT undo (the documented tooth of declaring no support).
 *
 * Creates its own Schema + Resolver + mongo instance; shares nothing with jest.setup.js.
 */

const { MongoMemoryReplSet } = require('mongodb-memory-server');
const MongoClient = require('@coderich/autograph-mongodb');
const { Schema, Resolver } = require('..');
const Emitter = require('../src/data/Emitter');

// ObjectId-coercing generator (mirrors jest.service): ids are stored as REAL ObjectIds, so the
// planner's injected (deserialized, string) values only match if injection re-rides the where
// pipelines — pinning the injection-serialization fix.
const generator = ({ value }) => {
  if (value instanceof MongoClient.ObjectId) return value;
  try { return new MongoClient.ObjectId(value); } catch { return value; }
};

const typeDefs = /* GraphQL */`
  type Writer @model {
    id: ID! @field(key: "_id")
    name: String!
    pins: [Pin]
    articles: [Article] @link(by: writer)
  }

  type Article @model {
    id: ID! @field(key: "_id")
    title: String!
    rank: Int
    writer: Writer!
  }

  type Pin @model(embed: true) {
    tag: String
    writer: Writer
  }
`;

let resolver;
let mongoServer;
let mongoClient;
let alice;
let bob;

beforeAll(async () => {
  mongoServer = await MongoMemoryReplSet.create({ replSet: { storageEngine: 'wiredTiger' } });
  mongoClient = new MongoClient({ uri: mongoServer.getUri(), options: { ignoreUndefined: false } });

  const schema = new Schema({
    namespace: 'fallback',
    generators: { default: generator },
    dataLoaders: { default: { cache: true } },
    dataSources: { default: { client: mongoClient, supports: [] } }, // the consumer's declaration
  }).merge(typeDefs);
  resolver = new Resolver({ schema, context: {} });

  [alice, bob] = await Promise.all([
    resolver.match('Writer').save({ name: 'alice' }),
    resolver.match('Writer').save({ name: 'bob' }),
  ]);
  // alice pins bob; bob pins nobody — for the embedded-prefix lift ('pins.writer.name')
  await resolver.match('Writer').id(alice.id).save({ pins: [{ tag: 'fav', writer: bob.id }] });
  await Promise.all([
    resolver.match('Article').save({ title: 'A1', rank: 1, writer: alice.id }),
    resolver.match('Article').save({ title: 'A2', rank: 2, writer: alice.id }),
    resolver.match('Article').save({ title: 'B1', rank: 3, writer: bob.id }),
  ]);
}, 60000);

afterAll(async () => {
  await mongoClient.disconnect();
  await mongoServer.stop();
});

describe('joins fallback — planner-resolved, driver never sees query.joins', () => {
  let prepareSpy;
  beforeEach(() => { prepareSpy = jest.spyOn(mongoClient, 'prepare'); });
  afterEach(() => {
    // THE invariant: no query handed to the driver ever carries joins or a session.
    prepareSpy.mock.calls.forEach(([q]) => {
      expect(q.joins ?? []).toHaveLength(0);
      expect(q.options?.session).toBeUndefined();
    });
    prepareSpy.mockRestore();
  });

  test('where by FK sub-path (stored side) pre-queries and injects $in', async () => {
    const rows = await resolver.match('Article').where({ 'writer.name': 'alice' }).many();
    expect(rows.map(r => r.title).sort()).toEqual(['A1', 'A2']);
  });

  test('where by virtual reverse-link sub-path resolves through the linkBy column', async () => {
    const rows = await resolver.match('Writer').where({ 'articles.title': 'B1' }).many();
    expect(rows.map(r => r.name)).toEqual(['bob']);
  });

  test('count with a join-shaped where', async () => {
    expect(await resolver.match('Article').where({ 'writer.name': 'alice' }).count()).toBe(2);
  });

  test('an empty pre-query short-circuits without a root driver query', async () => {
    const before = prepareSpy.mock.calls.length;
    expect(await resolver.match('Article').where({ 'writer.name': 'nobody' }).many()).toEqual([]);
    expect(await resolver.match('Article').where({ 'writer.name': 'nobody' }).count()).toBe(0);
    // Only the Writer pre-query dispatches (once — the second is a DataLoader cache hit);
    // the Article root query NEVER reaches the driver.
    const models = prepareSpy.mock.calls.slice(before).map(([q]) => q.model);
    expect(models).toEqual(expect.arrayContaining(['Writer']));
    expect(models).not.toContain('Article');
  });

  test('sort by joined field falls back to in-memory sort with pagination intact', async () => {
    const page = await resolver.match('Article').sort({ writer: { name: 'desc' }, rank: 'asc' }).limit(2).many();
    expect(page.map(r => r.title)).toEqual(['B1', 'A1']); // bob first (desc), then alice's by rank
  });

  test('embedded-prefix stored FK lifts — inject at the local dotted column', async () => {
    // Pin is embedded on Writer; Pin.writer is the FK. The lift pre-queries Writer by name and
    // injects at 'pins.writer' — a real local column on the embedded docs.
    const rows = await resolver.match('Writer').where({ 'pins.writer.name': 'bob' }).many();
    expect(rows.map(r => r.name)).toEqual(['alice']);
    expect(await resolver.match('Writer').where({ 'pins.writer.name': 'nobody' }).many()).toEqual([]);
  });

  test('bare virtual-FK equality lifts — condition on the foreign pk', async () => {
    const [a1] = await resolver.match('Article').where({ title: 'A1' }).many();
    const rows = await resolver.match('Writer').where({ articles: `${a1.id}` }).many();
    expect(rows.map(r => r.name)).toEqual(['alice']);
  });

  test('LOUD edges: join-shaped SORT deeper than a first-segment FK rejects', async () => {
    // Sorting by a multi-valued joined attribute (which pin?) is ill-defined — never silent.
    await expect(resolver.match('Writer').sort({ pins: { writer: { name: 'asc' } } }).many())
      .rejects.toThrow(/join path "pins.writer.name" requires driver join support/);
    await expect(resolver.match('Writer').sort({ articles: 'asc' }).many())
      .rejects.toThrow(/join path "articles" requires driver join support/);
  });
});

describe('transactions fallback — scopes are inert for the source (uncarried semantics)', () => {
  test('a write inside a manual transaction is durable IMMEDIATELY; rollback cannot undo', async () => {
    const txn = resolver.transaction();
    const doc = await txn.match('Writer').save({ name: 'no-txn-writer' });

    // Sessionless dispatch: durable the moment it is awaited — visible outside the "transaction".
    expect(await resolver.match('Writer').id(doc.id).one()).not.toBeNull();

    // The documented tooth of declaring no transaction support: rollback undoes NOTHING.
    await txn.rollback();
    expect(await resolver.match('Writer').id(doc.id).one()).not.toBeNull();

    await resolver.match('Writer').id(doc.id).delete();
  });

  test('a postMutation participant failure surfaces but the (already durable) write survives', async () => {
    const participant = (event, next) => {
      if (`${event.query.input?.name}` === 'poison-writer') throw new Error('participant-boom');
      next();
    };
    const off = Emitter.on({ event: 'postMutation', model: 'Writer' }, participant);

    try {
      await expect(resolver.match('Writer').save({ name: 'poison-writer' })).rejects.toThrow(/participant-boom/);
      const rows = await resolver.match('Writer').where({ name: 'poison-writer' }).many();
      expect(rows).toHaveLength(1); // uncarried: nothing existed to roll it back
      await resolver.match('Writer').id(rows[0].id).delete();
    } finally {
      off();
    }
  });

  test('postCommit fires immediately at lifecycle end — there is no settle to defer to', async () => {
    const seen = [];
    const off = Emitter.observe({ event: 'postCommit', model: 'Writer', crud: 'c' }, (event) => { seen.push(event.query.result.name); });

    try {
      const txn = resolver.transaction();
      const doc = await txn.match('Writer').save({ name: 'immediate-commit' });
      expect(seen).toEqual(['immediate-commit']); // fired before any commit() was ever called
      await txn.commit(); // meaningless for this source — must not double-fire
      expect(seen).toEqual(['immediate-commit']);
      await resolver.match('Writer').id(doc.id).delete();
    } finally {
      off();
    }
  });
});
