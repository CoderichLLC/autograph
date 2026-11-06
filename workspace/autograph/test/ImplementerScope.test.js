'use strict';

/**
 * Implementers of a persisted interface share the interface's collection (0.15.15). A query made
 * through an implementer must see only that implementer's documents: before this fix,
 * resolver.match('<Implementer>') read, updated and deleted every document in the collection.
 */

const { MongoMemoryReplSet } = require('mongodb-memory-server');
const MongoClient = require('@coderich/autograph-mongodb');
const { Schema, Resolver } = require('..');

let seq = 0;
const nextId = () => (++seq).toString(16).padStart(24, '0');
const generator = ({ value }) => (value != null ? value : nextId());

const typeDefs = /* GraphQL */`
  type Place @model(key: "place") {
    id: ID! @field(key: "_id")
    name: String
    depts: [Dept!] @link(by: place)
  }

  enum UnitKind { dept doc }

  interface Unit @model(key: "unit", oneOf: true, typeField: "kind") {
    id: ID! @field(key: "_id")
    kind: UnitKind! @field(key: "unit_kind")
    label: String
    place: Place
  }

  type Dept implements Unit @model(typeValue: "dept") { floor: Int }
  type Doc implements Unit @model(typeValue: "doc") { npi: String }
`;

let resolver, place, dept, doc;
let mongoServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryReplSet.create({ replSet: { storageEngine: 'wiredTiger' } });
  const mongoClient = new MongoClient({ uri: mongoServer.getUri(), options: { ignoreUndefined: false } });
  const config = {
    namespace: 'implementerscope',
    generators: { default: generator },
    dataLoaders: { default: { cache: false } },
    dataSources: { default: { client: mongoClient } },
  };
  resolver = new Resolver({ schema: new Schema(config).merge(typeDefs), context: {} });

  place = await resolver.match('Place').save({ name: 'Main' });
  dept = await resolver.match('Unit').save({ dept: { label: 'shared', floor: 2, place: place.id } });
  doc = await resolver.match('Unit').save({ doc: { label: 'shared', npi: '123', place: place.id } });
});

afterAll(async () => {
  await mongoServer?.stop();
});

describe('implementer queries on a shared interface collection', () => {
  test('the interface reads every document', async () => {
    const units = await resolver.match('Unit').many();
    expect(units.map(u => u.kind).sort()).toEqual(['dept', 'doc']);
  });

  test('an implementer reads only its own documents', async () => {
    expect((await resolver.match('Dept').many()).map(u => `${u.id}`)).toEqual([`${dept.id}`]);
    expect((await resolver.match('Doc').where({ label: 'shared' }).many()).map(u => `${u.id}`)).toEqual([`${doc.id}`]);
    expect(await resolver.match('Doc').count()).toBe(1);
  });

  test('an implementer does not get a document of another implementer by id', async () => {
    expect(await resolver.match('Dept').id(doc.id).one()).toBeNull();
  });

  test('a where on the type field cannot widen an implementer query', async () => {
    expect(await resolver.match('Dept').where({ kind: 'doc' }).many()).toEqual([]);
  });

  test('a where through a link to an implementer matches only that implementer', async () => {
    expect(await resolver.match('Place').where({ depts: { kind: 'doc' } }).many()).toEqual([]);
    expect((await resolver.match('Place').where({ depts: { label: 'shared' } }).many()).map(p => `${p.id}`)).toEqual([`${place.id}`]);
  });

  test('an implementer update does not touch a document of another implementer', async () => {
    await expect(resolver.match('Dept').id(doc.id).save({ label: 'changed' })).rejects.toThrow();
    expect((await resolver.match('Unit').id(doc.id).one()).label).toBe('shared');
  });

  test('an implementer delete removes only its own documents', async () => {
    await resolver.match('Doc').where({ label: 'shared' }).delete();
    expect((await resolver.match('Unit').many()).map(u => u.kind)).toEqual(['dept']);
  });
});
