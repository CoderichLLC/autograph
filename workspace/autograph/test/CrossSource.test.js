'use strict';

/**
 * Cross-source join integration tests.
 *
 * Verifies that QueryPlanner transparently resolves joins that span two different
 * data sources (MongoDB + Postgres) — covering cross-source WHERE pre-queries,
 * cross-source SORT with in-memory pagination, the virtual reverse-link case,
 * and count/findOne behaviour.
 *
 * This test creates its own Schema + Resolver with two named dataSources and
 * does NOT share state with the global jest.setup.js resolver.
 */

// eslint-disable-next-line import/no-extraneous-dependencies
const { MongoMemoryReplSet } = require('mongodb-memory-server');
// eslint-disable-next-line import/no-extraneous-dependencies
const { newDb } = require('pg-mem');
// eslint-disable-next-line import/no-extraneous-dependencies
const MongoClient = require('@coderich/autograph-mongodb');
// eslint-disable-next-line import/no-extraneous-dependencies
const PostgresDriver = require('@coderich/autograph-postgres');
const { Schema, Resolver } = require('@coderich/autograph');

// Sequential string IDs — identical generator for both sources.
// Plain strings work as MongoDB _id and Postgres TEXT, avoiding ObjectId conversion.
let seq = 0;
const nextId = () => (++seq).toString(16).padStart(24, '0');
const generator = ({ value }) => (value != null ? value : nextId());

// Musician lives on MongoDB (default source); Album lives on Postgres.
// Musician.albums is the virtual reverse side of Album.musician.
const typeDefs = /* GraphQL */`
  type Musician @model {
    id: ID! @field(key: "_id")
    name: String!
    genre: String
    albums: [Album] @link(by: musician)
  }

  type Album @model(source: "postgres") {
    id: ID!
    title: String!
    year: Int
    musician: Musician!
  }
`;

let resolver;
let mongoServer;

// Seed data references populated in beforeAll
let alice;
let bob;
let carol;
let rockA;
let rockB;
let jazzA;
let classicalA;

beforeAll(async () => {
  // --- MongoDB (Musician) ---
  mongoServer = await MongoMemoryReplSet.create({ replSet: { storageEngine: 'wiredTiger' } });
  const mongoClient = new MongoClient({
    uri: mongoServer.getUri(),
    options: { ignoreUndefined: false },
  });

  // --- Postgres (Album) ---
  const pgMem = newDb();
  const { Pool } = pgMem.adapters.createPg();
  const pgPool = new Pool();
  const pgClient = new PostgresDriver({ pool: pgPool });

  const config = {
    namespace: 'crosssource',
    generators: { default: generator },
    dataLoaders: { default: { cache: true } },
    dataSources: {
      default: { client: mongoClient },
      postgres: { client: pgClient },
    },
  };

  const schema = new Schema(config).merge(typeDefs);
  resolver = new Resolver({ schema, context: {} });

  // Create Postgres tables for every model on the "postgres" source
  const parsed = schema.parse();
  const pgSource = parsed.models.Album.source;
  const pgModels = Object.values(parsed.models).filter(m => m.isMarkedModel && !m.isEmbedded && m.source === pgSource);

  for (const model of pgModels) {
    const cols = Object.values(model.fields)
      .filter(f => !f.isVirtual)
      .map((field) => {
        const pk = field.isPrimaryKey ? ' PRIMARY KEY' : '';
        const type = (field.isArray || (field.isEmbedded && field.model)) ? 'JSONB'
          : field.type === 'Int' ? 'INTEGER'
          : 'TEXT';
        return `"${field.key}" ${type}${pk}`;
      });
    // eslint-disable-next-line no-await-in-loop
    await pgPool.query(`CREATE TABLE IF NOT EXISTS "${model.key}" (${cols.join(', ')})`);
  }

  // Seed Musicians into MongoDB
  [alice, bob, carol] = await Promise.all([
    resolver.match('Musician').save({ name: 'Alice', genre: 'rock' }),
    resolver.match('Musician').save({ name: 'Bob', genre: 'jazz' }),
    resolver.match('Musician').save({ name: 'Carol', genre: 'classical' }),
  ]);

  // Seed Albums into Postgres (Alice has two so multi-result WHERE can be tested)
  [rockA, rockB, jazzA, classicalA] = await Promise.all([
    resolver.match('Album').save({ title: 'Rock A', year: 2000, musician: alice.id }),
    resolver.match('Album').save({ title: 'Rock B', year: 2005, musician: alice.id }),
    resolver.match('Album').save({ title: 'Jazz A', year: 2010, musician: bob.id }),
    resolver.match('Album').save({ title: 'Classical A', year: 1990, musician: carol.id }),
  ]);
}, 60000);

afterAll(async () => {
  await mongoServer?.stop();
});

// ---------------------------------------------------------------------------
// Cross-source WHERE — pre-query the foreign source, inject $in on primary
// ---------------------------------------------------------------------------

describe('Cross-source WHERE', () => {
  test('filters albums by musician.genre (multi-result)', async () => {
    const results = await resolver.match('Album').where({ musician: { genre: 'rock' } }).many();
    expect(results).toHaveLength(2);
    expect(results.map(r => r.title).sort()).toEqual(['Rock A', 'Rock B']);
  });

  test('filters albums by musician.genre (single result)', async () => {
    const results = await resolver.match('Album').where({ musician: { genre: 'jazz' } }).many();
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Jazz A');
  });

  test('findOne with cross-source WHERE', async () => {
    const result = await resolver.match('Album').where({ musician: { genre: 'classical' } }).one();
    expect(result).toMatchObject({ title: 'Classical A' });
  });

  test('count with cross-source WHERE', async () => {
    expect(await resolver.match('Album').where({ musician: { genre: 'rock' } }).count()).toBe(2);
    expect(await resolver.match('Album').where({ musician: { genre: 'jazz' } }).count()).toBe(1);
  });

  test('empty pre-query short-circuits — findMany returns []', async () => {
    const results = await resolver.match('Album').where({ musician: { genre: 'country' } }).many();
    expect(results).toEqual([]);
  });

  test('empty pre-query short-circuits — findOne returns null', async () => {
    const result = await resolver.match('Album').where({ musician: { genre: 'country' } }).one();
    expect(result).toBeNull();
  });

  test('empty pre-query short-circuits — count returns 0', async () => {
    const count = await resolver.match('Album').where({ musician: { genre: 'country' } }).count();
    expect(count).toBe(0);
  });

  test('same-source WHERE is unaffected when no cross-source paths', async () => {
    const results = await resolver.match('Album').where({ year: 2000 }).many();
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Rock A');
  });
});

// ---------------------------------------------------------------------------
// Cross-source SORT — batch-fetch sort values, sort in-memory, paginate
// ---------------------------------------------------------------------------

describe('Cross-source SORT', () => {
  // Secondary tiebreaker 'title: asc' makes Alice's two albums deterministic
  const sortAsc = { musician: { name: 'asc' }, title: 'asc' };
  const sortDesc = { musician: { name: 'desc' }, title: 'asc' };

  test('sorts all albums by musician.name asc (+ title tiebreaker)', async () => {
    const results = await resolver.match('Album').sort(sortAsc).many();
    expect(results.map(r => r.title)).toEqual(['Rock A', 'Rock B', 'Jazz A', 'Classical A']);
  });

  test('sorts all albums by musician.name desc (+ title tiebreaker)', async () => {
    const results = await resolver.match('Album').sort(sortDesc).many();
    expect(results.map(r => r.title)).toEqual(['Classical A', 'Jazz A', 'Rock A', 'Rock B']);
  });

  test('cross-source SORT + limit', async () => {
    const results = await resolver.match('Album').sort(sortAsc).limit(2).many();
    expect(results).toHaveLength(2);
    expect(results.map(r => r.title)).toEqual(['Rock A', 'Rock B']);
  });

  test('cross-source SORT + skip', async () => {
    const results = await resolver.match('Album').sort(sortAsc).skip(2).many();
    expect(results).toHaveLength(2);
    expect(results.map(r => r.title)).toEqual(['Jazz A', 'Classical A']);
  });

  test('cross-source SORT + skip + limit (pagination slice)', async () => {
    const results = await resolver.match('Album').sort(sortAsc).skip(1).limit(2).many();
    expect(results).toHaveLength(2);
    expect(results.map(r => r.title)).toEqual(['Rock B', 'Jazz A']);
  });

  test('findOne with cross-source SORT returns first result after sort', async () => {
    const result = await resolver.match('Album').sort(sortAsc).one();
    expect(result).toMatchObject({ title: 'Rock A' });
  });
});

// ---------------------------------------------------------------------------
// Combined cross-source WHERE + SORT
// ---------------------------------------------------------------------------

describe('Cross-source WHERE + SORT combined', () => {
  test('filters by musician.genre then sorts by musician.name + title', async () => {
    // Only rock albums should survive the WHERE; Alice has two
    const results = await resolver.match('Album')
      .where({ musician: { genre: 'rock' } })
      .sort({ musician: { name: 'asc' }, title: 'asc' })
      .many();
    expect(results).toHaveLength(2);
    expect(results.map(r => r.title)).toEqual(['Rock A', 'Rock B']);
  });

  test('empty WHERE short-circuits even when SORT is specified', async () => {
    const results = await resolver.match('Album')
      .where({ musician: { genre: 'country' } })
      .sort({ musician: { name: 'asc' } })
      .many();
    expect(results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Virtual reverse link — Musician.albums → Album.musician
// ---------------------------------------------------------------------------

describe('Virtual reverse link (Musician → albums)', () => {
  test('filters musicians by album.title', async () => {
    const results = await resolver.match('Musician').where({ albums: { title: 'Jazz A' } }).many();
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('Bob');
  });

  test('filters musicians by album.year', async () => {
    const results = await resolver.match('Musician').where({ albums: { year: 1990 } }).many();
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('Carol');
  });

  test('returns multiple musicians when multiple albums match different musicians', async () => {
    // All albums exist (year > 1900), so all musicians returned
    const results = await resolver.match('Musician').where({ albums: { year: 2000 } }).many();
    expect(results).toHaveLength(1); // only Alice has an album from year 2000
    expect(results[0].name).toBe('Alice');
  });

  test('empty reverse pre-query short-circuits', async () => {
    const results = await resolver.match('Musician').where({ albums: { title: 'nonexistent' } }).many();
    expect(results).toEqual([]);
  });
});
