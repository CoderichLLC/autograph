'use strict';

/**
 * Relation-field WHERE operands — the shapes the dogfood hit live, all of which silently
 * over-matched (returned every row) instead of filtering or refusing:
 *
 *   1. An OPERATOR OBJECT on a relation field (`tags: { $exists: false }`) is a FIELD-LEVEL
 *      predicate on the local FK column — never a join. The driver-joins path (#finalize)
 *      already treats it that way; the planner fallback misread it as a join sub-path
 *      ('labels.$exists'), pre-queried the foreign model with a dangling operator that the
 *      transform dropped, and matched every related row.
 *   2. A NESTED WHERE on a relation field whose FK column carries a `serialize` pipeline
 *      (`tags: { name: 'red' }` with `serialize: toString`) must NOT ride that pipeline —
 *      toString of the object produced the string "[object Object]", which downstream spread
 *      into per-character keys and degenerated to match-all.
 *   3. A dangling operator at the ROOT of a where (`{ $exists: false }` with no field) is a
 *      vocabulary violation — refuse loudly, never drop silently.
 *   4. `.where(null)` is "no constraint" — same as omitting the call (GraphQL's nullable
 *      `where:` argument delivers exactly this), not a deepmerge TypeError.
 *
 * Models mirror the dogfood's shape: data-key aliases on both sides of the link, a
 * `serialize: toString` on the FK column, string ids (Sails-era data).
 */

const { MongoMemoryReplSet } = require('mongodb-memory-server');
const MongoClient = require('@coderich/autograph-mongodb');
const { Schema, Resolver } = require('..');

const typeDefs = /* GraphQL */`
  type Contact @model {
    id: ID! @field(key: "_id")
    name: String!
    primary: Tag @field(key: "primaryLabel")
    tags: [Tag] @field(key: "labels", serialize: toString)
  }
  type Tag @model {
    id: ID! @field(key: "_id")
    name: String! @field(key: "title")
  }
`;

let resolver;
let mongoServer;
let mongoClient;

beforeAll(async () => {
  mongoServer = await MongoMemoryReplSet.create({ replSet: { storageEngine: 'wiredTiger' } });
  mongoClient = new MongoClient({ uri: mongoServer.getUri(), options: { ignoreUndefined: false } });

  const schema = new Schema({
    namespace: 'relwhere',
    // String ids, supplied explicitly by the seed — mirrors data whose ids are not ObjectIds.
    generators: { default: ({ value }) => (value == null ? String(new MongoClient.ObjectId()) : value) },
    dataLoaders: { default: { cache: true } },
    dataSources: { default: { client: mongoClient, supports: [] } }, // planner fallback — the DAL host's configuration
  }).merge(typeDefs);
  resolver = new Resolver({ schema, context: {} });

  // ASYMMETRIC on purpose: 2 tagged, 1 untagged; 1 with primary, 2 without; two distinct tags.
  // A symmetric seed let the broken match-all behavior return coincidentally-correct counts.
  await resolver.match('Tag').save({ id: 't-red', name: 'red' });
  await resolver.match('Tag').save({ id: 't-blue', name: 'blue' });
  await resolver.match('Contact').save({ id: 'c-anne', name: 'anne', primary: 't-red', tags: ['t-red'] });
  await resolver.match('Contact').save({ id: 'c-bill', name: 'bill' });
  await resolver.match('Contact').save({ id: 'c-cara', name: 'cara', tags: ['t-blue'] });
  // EMPTY array ≠ missing: dorothea is "untagged" to a human but $exists-visible to the driver —
  // the case that makes $size (missing ≡ 0) the untagged predicate rather than $exists.
  await resolver.match('Contact').save({ id: 'c-dora', name: 'dorothea', tags: [] });
}, 60000);

afterAll(async () => {
  await mongoClient.disconnect();
  await mongoServer.stop();
});

describe('an operator object on a relation field is a LOCAL column predicate — never a join', () => {
  let prepareSpy;
  beforeEach(() => { prepareSpy = jest.spyOn(mongoClient, 'prepare'); });
  afterEach(() => { prepareSpy.mockRestore(); });

  test('list FK: $exists false finds the untagged row, and no foreign pre-query dispatches', async () => {
    const rows = await resolver.match('Contact').where({ tags: { $exists: false } }).many();
    expect(rows.map(r => r.name)).toEqual(['bill']);
    expect(prepareSpy.mock.calls.map(([q]) => q.model)).not.toContain('Tag');
  });

  test('list FK: $exists true finds the tagged rows — INCLUDING an empty array (it is non-null)', async () => {
    const rows = await resolver.match('Contact').where({ tags: { $exists: true } }).many();
    expect(rows.map(r => r.name).sort()).toEqual(['anne', 'cara', 'dorothea']);
  });

  test('singular FK: $exists false / true split the rows', async () => {
    const without = await resolver.match('Contact').where({ primary: { $exists: false } }).many();
    const withP = await resolver.match('Contact').where({ primary: { $exists: true } }).many();
    expect(without.map(r => r.name).sort()).toEqual(['bill', 'cara', 'dorothea']);
    expect(withP.map(r => r.name)).toEqual(['anne']);
  });

  test('count agrees with many — the live symptom was three predicates, one identical count', async () => {
    expect(await resolver.match('Contact').where({ tags: { $exists: false } }).count()).toBe(1);
    expect(await resolver.match('Contact').where({ tags: { $exists: true } }).count()).toBe(3);
  });
});

describe('a nested where on a serialize-carrying FK column survives as a JOIN — the pipeline never touches it', () => {
  test('nested match finds exactly the matching row — not every tagged row', async () => {
    const red = await resolver.match('Contact').where({ tags: { name: 'red' } }).many();
    const blue = await resolver.match('Contact').where({ tags: { name: 'blue' } }).many();
    expect(red.map(r => r.name)).toEqual(['anne']);
    expect(blue.map(r => r.name)).toEqual(['cara']);
  });

  test('nested miss finds nothing (not every row)', async () => {
    expect(await resolver.match('Contact').where({ tags: { name: 'nope' } }).many()).toEqual([]);
    expect(await resolver.match('Contact').where({ tags: { name: 'nope' } }).count()).toBe(0);
  });

  test('equality through the serialize pipeline still applies to SCALAR operands (the pipeline is for values, not shapes)', async () => {
    // A bare id operand rides `serialize: toString` exactly as before — this pins that the
    // nested-where guard did not turn off value serialization.
    const rows = await resolver.match('Contact').where({ tags: 't-red' }).many();
    expect(rows.map(r => r.name)).toEqual(['anne']);
  });

  test('an object operand carrying the LOOKUP key is a VALUE — $fk reduces it, pipelines apply', async () => {
    // `{ id: … }` is a fetched-document operand, not a nested where (the local resolver's
    // long-standing reduction — same contract the remote client's lift pins on its side).
    const rows = await resolver.match('Contact').where({ tags: { id: 't-red' } }).many();
    expect(rows.map(r => r.name)).toEqual(['anne']);
  });
});

describe('vocabulary violations refuse loudly instead of dropping silently', () => {
  test('a dangling operator at the where ROOT throws by name', async () => {
    await expect(resolver.match('Contact').where({ $exists: false }).count())
      .rejects.toThrow(/\$exists/);
  });

  test('a dangling operator at the root of a NESTED relation where throws too', async () => {
    // `{ tags: { $exists: false } }` is the field-level form (valid, tested above); this is the
    // genuinely malformed variant: an operator dangling INSIDE a nested where's field position.
    await expect(resolver.match('Contact').where({ tags: { name: { $ne: 'x' }, $exists: false } }).count())
      .rejects.toThrow(/\$exists/);
  });
});

describe('$size on relation arrays and strings — the untagged predicate', () => {
  test('$size: 0 is "untagged" — missing AND empty arrays (missing ≡ 0)', async () => {
    const rows = await resolver.match('Contact').where({ tags: { $size: 0 } }).many();
    expect(rows.map(r => r.name).sort()).toEqual(['bill', 'dorothea']);
  });

  test('$size ranges: { $gt: 0 } is "has at least one tag"', async () => {
    const rows = await resolver.match('Contact').where({ tags: { $size: { $gt: 0 } } }).many();
    expect(rows.map(r => r.name).sort()).toEqual(['anne', 'cara']);
    expect(await resolver.match('Contact').where({ tags: { $size: 1 } }).count()).toBe(2);
  });

  test('$size on a String field measures code points', async () => {
    const rows = await resolver.match('Contact').where({ name: { $size: { $gt: 4 } } }).many();
    expect(rows.map(r => r.name)).toEqual(['dorothea']);
    expect(await resolver.match('Contact').where({ name: { $size: 4 } }).count()).toBe(3);
  });

  test('$size inside a nested RELATION where re-roots through the planner', async () => {
    // Tag names: red (3), blue (4) — length-4 tag names select cara's tag.
    const rows = await resolver.match('Contact').where({ tags: { name: { $size: 4 } } }).many();
    expect(rows.map(r => r.name)).toEqual(['cara']);
  });

  test('the serialize pipeline never touches the $size operand', async () => {
    // tags carries `serialize: toString` — a mangled operand would stringify the count and
    // match nothing (or everything). The operand is a LENGTH, not a field value.
    expect(await resolver.match('Contact').where({ tags: { $size: { $lte: 1 } } }).count()).toBe(4);
  });
});

describe('where(null) means "no constraint"', () => {
  test('null behaves as an omitted where', async () => {
    expect(await resolver.match('Contact').where(null).count()).toBe(4);
  });
});
