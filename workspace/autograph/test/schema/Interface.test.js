const { makeExecutableSchema } = require('@graphql-tools/schema');
const Schema = require('../../src/schema/Schema');

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
});
