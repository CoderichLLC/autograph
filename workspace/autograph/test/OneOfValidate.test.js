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

  # EMBEDDED @oneOf: unlike Comp above (a ROOT/persisted @oneOf model whose stored document IS the
  # variant), Target is used as a FIELD inside a parent (Holder.target). The whole embedded value is a
  # property of the parent, so a parent update must be able to REDEFINE it to a different variant,
  # replacing the entire subdocument (no sibling variant fields left behind). The discriminator is NOT
  # immutable here — that guard is only for root @oneOf, where morphing 'type' mutates a record's identity.
  type Geo @model(embed: true) { lat: Float! lng: Float! }

  enum TargetType { geoTarget poiTarget }

  interface Target @model(embed: true, oneOf: true) {
    type: TargetType! @field(crud: r)
    weight: Int!
  }
  type GeoTarget implements Target @model(embed: true, typeValue: "geoTarget") { geo: Geo! }
  type PoiTarget implements Target @model(embed: true, typeValue: "poiTarget") { poi: String! }

  type Holder @model(key: "holder") {
    id: ID! @field(key: "_id")
    name: String!
    target: Target
  }
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

/**
 * An EMBEDDED @oneOf field (Holder.target) is a discriminated union living inside a parent doc. It
 * updates like any ORDINARY embedded document (path of least surprise):
 *   - a SAME-variant update partial-merges (untouched fields are preserved);
 *   - a variant SWITCH is a full redefine — Query.toDriver detects the changed discriminator and
 *     $sets the whole subdocument, so no sibling variant's fields survive.
 * Contrast the root-@oneOf immutability block above — there the document itself IS the variant, so a
 * switch is rejected outright.
 */
describe('embedded @oneOf update (merges like an ordinary embedded doc; switch replaces)', () => {
  test('creates a parent with an embedded oneOf target', async () => {
    const created = await resolver.match('Holder').save({ name: 'h1', target: { geoTarget: { weight: 1, geo: { lat: 1, lng: 2 } } } });
    expect(created.target.type).toBe('geoTarget');
    expect(created.target.weight).toBe(1);
    expect(created.target.geo).toEqual({ lat: 1, lng: 2 });
  });

  test('SAME-variant update partial-merges — untouched fields are preserved', async () => {
    const created = await resolver.match('Holder').save({ name: 'h2', target: { geoTarget: { weight: 2, geo: { lat: 3, lng: 4 } } } });

    // Touch only `weight`; `geo` (same variant, not supplied) must survive the merge.
    const updated = await resolver.match('Holder').id(created.id).save({ target: { geoTarget: { weight: 22 } } });
    expect(updated.target.type).toBe('geoTarget');
    expect(updated.target.weight).toBe(22);
    expect(updated.target.geo).toEqual({ lat: 3, lng: 4 });

    // Re-read from the driver to prove the stored subdocument merged (geo not clobbered).
    const read = await resolver.match('Holder').id(created.id).one();
    expect(read.target.weight).toBe(22);
    expect(read.target.geo).toEqual({ lat: 3, lng: 4 });
  });

  test('nested same-variant merge — untouched keys inside the embedded object survive', async () => {
    const created = await resolver.match('Holder').save({ name: 'h2b', target: { geoTarget: { weight: 1, geo: { lat: 3, lng: 4 } } } });
    const updated = await resolver.match('Holder').id(created.id).save({ target: { geoTarget: { geo: { lat: 30 } } } });
    expect(updated.target.geo).toEqual({ lat: 30, lng: 4 }); // lng preserved
    expect(updated.target.weight).toBe(1); // weight preserved
  });

  test('variant SWITCH replaces the entire field — sibling variant fields are GONE', async () => {
    const created = await resolver.match('Holder').save({ name: 'h3', target: { geoTarget: { weight: 2, geo: { lat: 3, lng: 4 } } } });

    // Switch geoTarget -> poiTarget: a full redefine, not a morph of the same variant.
    const updated = await resolver.match('Holder').id(created.id).save({ target: { poiTarget: { weight: 9, poi: 'xyz' } } });
    expect(updated.target.type).toBe('poiTarget');
    expect(updated.target.poi).toBe('xyz');
    expect(updated.target.geo).toBeUndefined(); // sibling variant's field is GONE, not left behind

    const read = await resolver.match('Holder').id(created.id).one();
    expect(read.target.type).toBe('poiTarget');
    expect(read.target.poi).toBe('xyz');
    expect(read.target.geo).toBeUndefined();
    expect(read.target.weight).toBe(9);
  });

  test('switches back to the original variant type', async () => {
    const created = await resolver.match('Holder').save({ name: 'h4', target: { poiTarget: { weight: 5, poi: 'first' } } });
    const updated = await resolver.match('Holder').id(created.id).save({ target: { geoTarget: { weight: 6, geo: { lat: 7, lng: 8 } } } });
    expect(updated.target.type).toBe('geoTarget');
    expect(updated.target.geo).toEqual({ lat: 7, lng: 8 });
    expect(updated.target.poi).toBeUndefined();
  });

  test('leaving the embedded target untouched on an unrelated parent update preserves it', async () => {
    const created = await resolver.match('Holder').save({ name: 'h5', target: { geoTarget: { weight: 3, geo: { lat: 9, lng: 10 } } } });
    const updated = await resolver.match('Holder').id(created.id).save({ name: 'renamed' });
    expect(updated.name).toBe('renamed');
    expect(updated.target.type).toBe('geoTarget');
    expect(updated.target.geo).toEqual({ lat: 9, lng: 10 });
    expect(updated.target.weight).toBe(3);
  });
});
