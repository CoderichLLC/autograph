'use strict';

/**
 * Regression (ENG-885): @field(default:) on an EMBEDDED-ARRAY element field must apply on the
 * UPDATE path, not just create. An embedded array is replaced wholesale on update (there is no
 * element identity to merge by), so its elements are effectively CREATED — 0.12 encoded this as
 * `subCrud = crud === 'update' && isArray ? 'create' : crud` in Model#getShape, and pushOne still
 * routes new elements through transformers.create. The 0.13 transformer rewrite recursed embedded
 * fields through transformers.update unconditionally, which seeds no defaultValue: a name-only
 * tag saved via update persisted WITHOUT its weight default.
 *
 * Reads mask the defect (docTransform falls back to defaultValue), so these tests assert against
 * the RAW stored row — exactly what external consumers of the database (spitfire's packager) see.
 */

const { MongoMemoryReplSet } = require('mongodb-memory-server');
const MongoClient = require('@coderich/autograph-mongodb');
const { Schema, Resolver } = require('..');

let seq = 0;
const nextId = () => (++seq).toString(16).padStart(24, '0');
const generator = ({ value }) => (value != null ? value : nextId());

const typeDefs = /* GraphQL */`
  type PlaceTag @model(embed: true) {
    name: String!
    weight: String @field(default: "medium")
  }

  type Prefs @model(embed: true) {
    theme: String
    volume: String @field(default: "loud")
  }

  type Place @model(key: "place") {
    id: ID! @field(key: "_id")
    name: String!
    tags: [PlaceTag]
    prefs: Prefs
  }
`;

let resolver;
let mongoServer;
let rawPlace; // the driver's raw collection accessor — bypasses docTransform's read-side defaulting

beforeAll(async () => {
  mongoServer = await MongoMemoryReplSet.create({ replSet: { storageEngine: 'wiredTiger' } });
  const mongoClient = new MongoClient({ uri: mongoServer.getUri(), options: { ignoreUndefined: false } });
  const config = {
    namespace: 'embeddeddefault',
    generators: { default: generator },
    dataLoaders: { default: { cache: true } },
    dataSources: { default: { client: mongoClient } },
  };
  const schema = new Schema(config).merge(typeDefs);
  resolver = new Resolver({ schema, context: {} });
  rawPlace = mongoClient.collection('place');
});

afterAll(async () => {
  await mongoServer?.stop();
});

describe('embedded-array element defaults', () => {
  test('CREATE: a name-only element is stored WITH its default', async () => {
    const created = await resolver.match('Place').save({ name: 'p1', tags: [{ name: 'room-1' }] });
    const raw = await rawPlace.findOne({ _id: created.id });
    expect(raw.tags).toEqual([{ name: 'room-1', weight: 'medium' }]);
  });

  test('UPDATE (wholesale array replace): a name-only element is stored WITH its default', async () => {
    const created = await resolver.match('Place').save({ name: 'p2', tags: [{ name: 'room-1' }] });

    // The prod repro: re-save the doc with name-only tags (Portal never sends weight).
    const updated = await resolver.match('Place').id(created.id).save({ tags: [{ name: 'room-1' }, { name: 'room-2' }] });
    expect(updated.tags).toHaveLength(2);

    const raw = await rawPlace.findOne({ _id: created.id });
    expect(raw.tags).toEqual([
      { name: 'room-1', weight: 'medium' },
      { name: 'room-2', weight: 'medium' },
    ]);
  });

  test('UPDATE: an element\'s EXPLICIT value beats the default', async () => {
    const created = await resolver.match('Place').save({ name: 'p3', tags: [{ name: 'a' }] });
    await resolver.match('Place').id(created.id).save({ tags: [{ name: 'a', weight: 'high' }, { name: 'b' }] });

    const raw = await rawPlace.findOne({ _id: created.id });
    expect(raw.tags).toEqual([
      { name: 'a', weight: 'high' },
      { name: 'b', weight: 'medium' },
    ]);
  });

  test('PUSH: a pushed name-only element is stored WITH its default (pre-existing create semantics)', async () => {
    const created = await resolver.match('Place').save({ name: 'p4', tags: [{ name: 'a' }] });
    await resolver.match('Place').id(created.id).push('tags', [{ name: 'b' }]);

    const raw = await rawPlace.findOne({ _id: created.id });
    expect(raw.tags).toEqual([
      { name: 'a', weight: 'medium' },
      { name: 'b', weight: 'medium' },
    ]);
  });
});

describe('SINGULAR embedded object keeps UPDATE (partial-merge) semantics — no default injection', () => {
  test('a partial update of a sibling key must NOT reset a stored value back to the default', async () => {
    const created = await resolver.match('Place').save({ name: 'p5', prefs: { theme: 'dark', volume: 'quiet' } });

    // Touch only `theme`; `volume` (explicitly stored as 'quiet') must survive untouched —
    // create-semantics here would stomp it back to the 'loud' default.
    await resolver.match('Place').id(created.id).save({ prefs: { theme: 'light' } });

    const raw = await rawPlace.findOne({ _id: created.id });
    expect(raw.prefs).toEqual({ theme: 'light', volume: 'quiet' });
  });
});
