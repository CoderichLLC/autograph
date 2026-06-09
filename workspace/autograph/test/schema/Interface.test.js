const { makeExecutableSchema } = require('@graphql-tools/schema');
const Schema = require('../../src/schema/Schema');
const QueryBuilder = require('../../src/query/QueryBuilder');

// Embedded interface (mirrors the in-house Kiosk pattern) whose two implementers each add their
// own field. Today Autograph only generates the interface's *own* fields into AnimalInputCreate,
// which is why every implementer field has to be redundantly re-declared on the interface (the
// "hack"). This asserts the union of implementer fields is aggregated automatically.
const typeDefs = `
  type Zoo @model(key: "zoo") {
    id: ID!
    animals: [Animal!]
  }

  interface Animal @model(embed: true, discriminator: "kind") {
    kind: String!
    name: String!
  }

  type Dog implements Animal @model(embed: true, typeKey: "k9") {
    kind: String!
    name: String!
    barkVolume: Int
  }

  type Cat implements Animal @model(embed: true, typeKey: "feline") {
    kind: String!
    name: String!
    livesLeft: Int
  }
`;

// Same shape, but the interface opts into @oneOf — its input should become a polymorphic
// @oneOf keyed by each implementer's typeKey, instead of the fat union input.
const oneOfTypeDefs = `
  type Shelter @model(key: "shelter") {
    id: ID!
    residents: [Critter!]
  }

  interface Critter @model(embed: true, discriminator: "kind", oneOf: true) {
    kind: String!
    name: String!
  }

  type Pup implements Critter @model(embed: true, typeKey: "k9") {
    kind: String!
    name: String!
    barkVolume: Int
  }

  type Kitty implements Critter @model(embed: true, typeKey: "feline") {
    kind: String!
    name: String!
    livesLeft: Int
  }
`;

describe('Interface', () => {
  test('interface InputCreate aggregates fields from all implementers', () => {
    const schema = new Schema({}).merge(typeDefs).api();
    const executable = makeExecutableSchema(schema.toObject());
    const fields = executable.getType('AnimalInputCreate').getFields();

    expect(fields).toHaveProperty('name'); // interface's own field
    expect(fields).toHaveProperty('barkVolume'); // Dog-only — must be aggregated onto the interface input
    expect(fields).toHaveProperty('livesLeft'); // Cat-only — must be aggregated onto the interface input
  });

  // Reads of an interface-typed field need a __resolveType so GraphQL can pick the concrete type.
  // It reads the declared discriminator field (here `kind`), whose value is the concrete type name.
  // The discriminator field holds a domain value (e.g. "k9"), NOT the GraphQL type name ("Dog").
  // __resolveType must MAP the value -> concrete type name via the typeKey registry.
  test('user-defined interface __resolveType maps the discriminator value to the concrete type', () => {
    const { resolvers } = new Schema({}).merge(typeDefs).api().toObject();
    expect(typeof resolvers.Animal?.__resolveType).toBe('function');
    expect(resolvers.Animal.__resolveType({ kind: 'k9', name: 'Rex' })).toBe('Dog');
    expect(resolvers.Animal.__resolveType({ kind: 'feline', name: 'Felix' })).toBe('Cat');
  });

  // @model(oneOf: true) → the interface input is a @oneOf keyed by each implementer's typeKey,
  // each pointing at that implementer's own input (not the fat union of all fields).
  test('oneOf interface generates a @oneOf input keyed by typeKey', () => {
    const executable = makeExecutableSchema(new Schema({}).merge(oneOfTypeDefs).api().toObject());

    const createInput = executable.getType('CritterInputCreate');
    expect(createInput.isOneOf).toBe(true);
    const createFields = createInput.getFields();
    expect(createFields).toHaveProperty('k9');
    expect(createFields).toHaveProperty('feline');
    expect(String(createFields.k9.type)).toBe('PupInputCreate');
    expect(String(createFields.feline.type)).toBe('KittyInputCreate');

    expect(executable.getType('CritterInputUpdate').isOneOf).toBe(true);
  });

  // Write-path round-trip: an implementer-only field (Dog.barkVolume, Feline.livesLeft) on an
  // embedded interface array must SURVIVE serialization. The interface's create/update transformer
  // is strictSchema — if its shape doesn't include the aggregated implementer fields, those values
  // get stripped before they ever reach the driver (the exact Kiosk title/poiItems bug).
  describe('embedded interface write round-trip (global schema)', () => {
    let schema, resolver, factory;

    beforeAll(() => {
      ({ schema, resolver } = global);
      factory = model => new QueryBuilder({ resolver, schema, query: { model }, context: {} });
    });

    test('implementer-only fields survive the create transform', async () => {
      const { input } = (await factory('Owner').save({
        name: 'Bob',
        critters: [
          { kind: 'k9', name: 'Rex', barkVolume: 11 },
          { kind: 'cat', name: 'Felix', livesLeft: 9 },
        ],
      }).transform()).toObject();

      expect(input.critters[0]).toMatchObject({ name: 'Rex', barkVolume: 11 });
      expect(input.critters[1]).toMatchObject({ name: 'Felix', livesLeft: 9 });
    });

    test('implementer-only fields survive the update transform', async () => {
      const { input } = (await factory('Owner').id('000000000000000000000001').save({
        critters: [{ kind: 'k9', name: 'Rex', barkVolume: 7 }],
      }).transform()).toObject();

      expect(input.critters[0]).toMatchObject({ name: 'Rex', barkVolume: 7 });
    });
  });

  // @oneOf interface input dispatch: the write carries a polymorphic wrapper { <typeKey>: {...} }.
  // The runtime must unwrap the single key, route the inner value through the CONCRETE model's
  // transformer, stamp the discriminator (= typeKey) so reads can __resolveType, and produce a
  // FLAT concrete doc (no wrapper key) — not the fat-input shape.
  describe('oneOf interface input dispatch (global schema)', () => {
    let schema, resolver, factory;

    beforeAll(() => {
      ({ schema, resolver } = global);
      factory = model => new QueryBuilder({ resolver, schema, query: { model }, context: {} });
    });

    test('create unwraps the oneOf key, routes to the concrete model, and stamps the discriminator', async () => {
      const { input } = (await factory('Keeper').save({
        name: 'Bob',
        varmints: [
          { k9: { name: 'Rex', barkVolume: 11 } },
          { cat: { name: 'Felix', livesLeft: 9 } },
        ],
      }).transform()).toObject();

      expect(input.varmints[0]).toMatchObject({ kind: 'k9', name: 'Rex', barkVolume: 11 });
      expect(input.varmints[0].k9).toBeUndefined(); // unwrapped, not nested
      expect(input.varmints[1]).toMatchObject({ kind: 'cat', name: 'Felix', livesLeft: 9 });
      expect(input.varmints[1].cat).toBeUndefined();
    });

    test('update dispatches the oneOf key the same way', async () => {
      const { input } = (await factory('Keeper').id('000000000000000000000001').save({
        varmints: [{ k9: { name: 'Rex', barkVolume: 7 } }],
      }).transform()).toObject();

      expect(input.varmints[0]).toMatchObject({ kind: 'k9', name: 'Rex', barkVolume: 7 });
      expect(input.varmints[0].k9).toBeUndefined();
    });
  });

  // The Resolver/ORM path has no GraphQL selection set, so interfaces should be fully transparent:
  // a real save -> read returns each concrete doc with its TYPE-SPECIFIC fields (barkVolume for the
  // dog, livesLeft for the cat) and no `... on` gymnastics. This is the actual DB round-trip (mongo
  // memory server via global.resolver), not just the transform pipeline.
  describe('Resolver path transparency (no `... on` required)', () => {
    let resolver;

    beforeAll(() => { ({ resolver } = global); });

    test('save + read an embedded interface returns concrete type-specific fields transparently', async () => {
      const owner = await resolver.match('Owner').save({
        name: 'Transparent',
        critters: [
          { kind: 'k9', name: 'Rex', barkVolume: 11 },
          { kind: 'cat', name: 'Felix', livesLeft: 9 },
        ],
      });

      const read = await resolver.match('Owner').id(owner.id).one();

      expect(read.critters[0]).toMatchObject({ kind: 'k9', name: 'Rex', barkVolume: 11 });
      expect(read.critters[1]).toMatchObject({ kind: 'cat', name: 'Felix', livesLeft: 9 });
      // Probe: is the GraphQL __typename present on the plain resolver read? (Documenting behavior.)
      console.log('[transparency probe] __typename on resolver read:', read.critters[0].__typename); // eslint-disable-line no-console
    });
  });
});
