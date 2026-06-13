'use strict';

/**
 * Regression: @oneOf interface create/update must validate against the CONCRETE variant only.
 *
 * The interface model aggregates EVERY implementer's fields (with their required flags) so that
 * inputs/resolvers work. But validation must NOT enforce a sibling variant's required fields:
 * creating a `withTitle` (which has no `label`) must not fail with "TextThing.text is required"
 * just because the sibling `withText` declares `label: TextThing!`.
 */

const { MongoMemoryReplSet } = require('mongodb-memory-server');
const MongoClient = require('@coderich/autograph-mongodb');
const { Schema, Resolver } = require('..');

let seq = 0;
const nextId = () => (++seq).toString(16).padStart(24, '0');
const generator = ({ value }) => (value != null ? value : nextId());

const typeDefs = /* GraphQL */`
  type TextThing { text: String! }
  type ListThing { items: [String!]! }

  enum CompType { withText withTitle objTitle listTitle }

  interface Comp @model(key: "comp", oneOf: true) {
    id: ID! @field(key: "_id")
    type: CompType! @field(crud: r)
    position: Int!
  }

  type WithText implements Comp @model(typeValue: "withText") { label: TextThing! }
  type WithTitle implements Comp @model(typeValue: "withTitle") { title: String! }

  # Same field NAME 'config', DIFFERENT types. ObjTitle is defined FIRST so the interface aggregates
  # 'config' as TextThing; creating a ListTitle (config: ListThing) must NOT be mangled by the
  # aggregated TextThing serializer on the way to storage (the toDriver dispatch fix).
  type ObjTitle implements Comp @model(typeValue: "objTitle") { config: TextThing! }
  type ListTitle implements Comp @model(typeValue: "listTitle") { config: ListThing! }
`;

let resolver;
let mongoServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryReplSet.create({ replSet: { storageEngine: 'wiredTiger' } });
  const mongoClient = new MongoClient({ uri: mongoServer.getUri(), options: { ignoreUndefined: false } });
  const config = {
    namespace: 'oneofvalidate',
    generators: { default: generator },
    dataLoaders: { default: { cache: true } },
    dataSources: { default: { client: mongoClient } },
  };
  const schema = new Schema(config).merge(typeDefs);
  resolver = new Resolver({ schema, context: {} });
});

afterAll(async () => {
  await mongoServer?.stop();
});

describe('@oneOf variant validation', () => {
  test('creating a variant does NOT require a SIBLING variant\'s required field', async () => {
    // Before the fix this threw "TextThing.text is required" (sibling withText.label aggregated as required).
    const created = await resolver.match('Comp').save({ withTitle: { position: 1, title: 'Hello' } });
    expect(created.type).toBe('withTitle');
    expect(created.title).toBe('Hello');
  });

  test('the other variant also creates, supplying only its own embedded required field', async () => {
    const created = await resolver.match('Comp').save({ withText: { position: 2, label: { text: 'Hi' } } });
    expect(created.type).toBe('withText');
    expect(created.label.text).toBe('Hi');
  });

  test('a variant missing its OWN required field still fails', async () => {
    await expect(resolver.match('Comp').save({ withTitle: { position: 3 } })).rejects.toThrow();
  });

  test('a field NAME shared by variants with DIFFERENT types is stored with the concrete shape', async () => {
    // Before the toDriver dispatch fix, `config` (aggregated as TextThing from ObjTitle) mangled
    // ListTitle's `config: { items: [...] }` into {} on the way to storage.
    const created = await resolver.match('Comp').save({ listTitle: { position: 4, config: { items: ['a', 'b'] } } });
    const read = await resolver.match('Comp').id(created.id).one();
    expect(read.type).toBe('listTitle');
    expect(read.config).toEqual({ items: ['a', 'b'] });
  });
});

/**
 * The @oneOf discriminator is framework-owned: stamped from the wrapper key, dropped from inputs
 * (crud:r), and — crucially — guarded by an auto-applied `immutable` validate rule so it cannot be
 * MORPHED on update. crud:r only governs the generated GraphQL surface; the resolver path below has
 * no such gate, so without `immutable` an update wrapped under a different variant key would silently
 * re-stamp the discriminator and partial-merge into a half-morphed doc. This proves it's rejected.
 */
describe('@oneOf discriminator immutability', () => {
  test('updating under the SAME variant key succeeds (discriminator unchanged)', async () => {
    const created = await resolver.match('Comp').save({ withTitle: { position: 10, title: 'Orig' } });
    const updated = await resolver.match('Comp').id(created.id).save({ withTitle: { title: 'Renamed' } });
    expect(updated.type).toBe('withTitle');
    expect(updated.title).toBe('Renamed');
  });

  test('updating under a DIFFERENT variant key is rejected (cannot morph the discriminator)', async () => {
    const created = await resolver.match('Comp').save({ withTitle: { position: 11, title: 'Orig' } });
    // withTitle -> withText would re-stamp `type` and merge WithText fields onto a WithTitle doc.
    await expect(
      resolver.match('Comp').id(created.id).save({ withText: { position: 11, label: { text: 'Nope' } } }),
    ).rejects.toThrow(/immutable/);

    // And the stored doc is untouched: still the original variant.
    const read = await resolver.match('Comp').id(created.id).one();
    expect(read.type).toBe('withTitle');
    expect(read.title).toBe('Orig');
  });
});
