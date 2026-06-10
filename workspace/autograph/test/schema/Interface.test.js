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

  interface Animal @model(embed: true, typeField: "kind") {
    kind: String!
    name: String!
  }

  type Dog implements Animal @model(embed: true, typeValue: "k9") {
    kind: String!
    name: String!
    barkVolume: Int
  }

  type Cat implements Animal @model(embed: true, typeValue: "feline") {
    kind: String!
    name: String!
    livesLeft: Int
  }
`;

// Same shape, but the interface opts into @oneOf — its input should become a polymorphic
// @oneOf keyed by each implementer's typeValue, instead of the fat union input.
const oneOfTypeDefs = `
  type Shelter @model(key: "shelter") {
    id: ID!
    residents: [Critter!]
  }

  interface Critter @model(embed: true, typeField: "kind", oneOf: true) {
    kind: String!
    name: String!
  }

  type Pup implements Critter @model(embed: true, typeValue: "k9") {
    kind: String!
    name: String!
    barkVolume: Int
  }

  type Kitty implements Critter @model(embed: true, typeValue: "feline") {
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
  // It reads the declared typeField field (here `kind`), whose value is the concrete type name.
  // The typeField field holds a domain value (e.g. "k9"), NOT the GraphQL type name ("Dog").
  // __resolveType must MAP the value -> concrete type name via the typeValue registry.
  test('user-defined interface __resolveType maps the typeField value to the concrete type', () => {
    const { resolvers } = new Schema({}).merge(typeDefs).api().toObject();
    expect(typeof resolvers.Animal?.__resolveType).toBe('function');
    expect(resolvers.Animal.__resolveType({ kind: 'k9', name: 'Rex' })).toBe('Dog');
    expect(resolvers.Animal.__resolveType({ kind: 'feline', name: 'Felix' })).toBe('Cat');
  });

  // @model(oneOf: true) → the interface input is a @oneOf keyed by each implementer's typeValue,
  // each pointing at that implementer's own input (not the fat union of all fields).
  test('oneOf interface generates a @oneOf input keyed by typeValue', () => {
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

  // @oneOf interface input dispatch: the write carries a polymorphic wrapper { <typeValue>: {...} }.
  // The runtime must unwrap the single key, route the inner value through the CONCRETE model's
  // transformer, stamp the typeField (= typeValue) so reads can __resolveType, and produce a
  // FLAT concrete doc (no wrapper key) — not the fat-input shape.
  describe('oneOf interface input dispatch (global schema)', () => {
    let schema, resolver, factory;

    beforeAll(() => {
      ({ schema, resolver } = global);
      factory = model => new QueryBuilder({ resolver, schema, query: { model }, context: {} });
    });

    test('create unwraps the oneOf key, routes to the concrete model, and stamps the typeField', async () => {
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

// interface -> implementer field inheritance: an implementer need only declare its OWN fields; the
// interface's fields are copied in automatically (with their directives), so makeExecutableSchema
// succeeds without re-declaration. This is the AG15 DRY-SDL feature.
describe('Interface field inheritance', () => {
  const { GraphQLNonNull } = require('graphql');

  test('an implementer that declares only its own field still satisfies the interface', () => {
    const td = `
      type Garage @model(key: "garage") { id: ID! vehicles: [Vehicle!] }
      interface Vehicle @model(embed: true, typeField: "kind") { kind: String! wheels: Int }
      type Car implements Vehicle @model(embed: true, typeValue: "car") { doors: Int }
    `;
    const executable = makeExecutableSchema(new Schema({}).merge(td).api().toObject()); // would throw if Car lacked kind/wheels
    const fields = executable.getType('Car').getFields();
    expect(fields).toHaveProperty('kind'); // inherited
    expect(fields).toHaveProperty('wheels'); // inherited
    expect(fields).toHaveProperty('doors'); // own
  });

  test('the implementer wins on conflict — a covariant (non-null) override is preserved, not overwritten', () => {
    const td = `
      type Catalog @model(key: "catalog") { id: ID! items: [Item!] }
      interface Item @model(embed: true) { id: ID! label: String }
      type Widget implements Item @model(embed: true) { label: String! }
    `;
    const fields = makeExecutableSchema(new Schema({}).merge(td).api().toObject()).getType('Widget').getFields();
    expect(fields).toHaveProperty('id'); // inherited
    expect(fields.label.type).toBeInstanceOf(GraphQLNonNull); // Widget's String! kept; NOT clobbered by interface's String
  });

  // Inheritance copies the whole FieldDefinitionNode (incl. its directive AST), so parse() processes the
  // interface's @field directives ON the concrete model — they don't just appear, they take effect:
  // default -> create-transform default, key -> storage column, serialize -> serialize pipeline,
  // persist -> non-persistable. Asserted against the interface's own field, so it's a true copy.
  test('inherited fields carry their interface @field directives and they take effect on the concrete model', () => {
    const td = `
      type Shelf @model(key: "shelf") { id: ID! books: [Book!] }
      interface Book @model(embed: true) {
        order: Int! @field(default: 0)
        isbn: String @field(key: "isbn_10")
        title: String @field(serialize: toUpperCase)
        draft: String @field(persist: false)
      }
      type Novel implements Book @model(embed: true) { author: String }
    `;
    const { Novel, Book } = new Schema({}).merge(td).parse().models;

    // @field(default:) -> feeds the create transformer's defaults (SchemaParser create defaults: curr.defaultValue)
    expect(Novel.fields.order.defaultValue).toBeDefined();
    expect(Novel.fields.order.defaultValue).toEqual(Book.fields.order.defaultValue);
    // @field(key:) -> remapped storage column
    expect(Novel.fields.isbn.key).toBe('isbn_10');
    // @field(serialize:) -> serialize pipeline (executed lazily by Pipeline.$serialize at transform time)
    expect(Novel.fields.title.pipelines.serialize).toContain('toUpperCase');
    expect(Novel.fields.title.pipelines.serialize).toEqual(Book.fields.title.pipelines.serialize);
    // @field(persist:) -> non-persistable
    expect(Novel.fields.draft.isPersistable).toBe(false);
  });

  test('inheritance is transitive (interface implementing interface)', () => {
    const td = `
      type Box @model(key: "box") { id: ID! things: [Leaf!] }
      interface Base @model(embed: true) { a: String }
      interface Mid implements Base @model(embed: true) { b: String }
      type Leaf implements Mid & Base @model(embed: true) { c: String }
    `;
    const executable = makeExecutableSchema(new Schema({}).merge(td).api().toObject());
    const leaf = executable.getType('Leaf').getFields();
    expect(Object.keys(leaf)).toEqual(expect.arrayContaining(['a', 'b', 'c'])); // grandparent + parent + own
    const mid = executable.getType('Mid').getFields();
    expect(Object.keys(mid)).toEqual(expect.arrayContaining(['a', 'b'])); // child interface also gets grandparent field
  });

  // Transparency: removing the redeclarations must NOT change either interface-input flow. (The
  // global-schema write-round-trip / oneOf-dispatch tests above are the runtime counterpart — they
  // pass identically whether or not the implementer fixtures redeclare interface fields.)
  test('fat-input flow is unchanged: interface input still aggregates the union; __resolveType still wired', () => {
    const td = `
      type Zoo @model(key: "zoo") { id: ID! animals: [Animal!] }
      interface Animal @model(embed: true, typeField: "kind") { kind: String! name: String! }
      type Dog implements Animal @model(embed: true, typeValue: "k9") { barkVolume: Int }
      type Cat implements Animal @model(embed: true, typeValue: "feline") { livesLeft: Int }
    `;
    const obj = new Schema({}).merge(td).api().toObject();
    const input = makeExecutableSchema(obj).getType('AnimalInputCreate').getFields();
    expect(input).toHaveProperty('name'); // interface field (implementers no longer redeclare it)
    expect(input).toHaveProperty('barkVolume'); // Dog-only, aggregated onto the fat input
    expect(input).toHaveProperty('livesLeft'); // Cat-only, aggregated onto the fat input
    // __resolveType maps the inherited typeField value -> concrete type
    expect(obj.resolvers.Animal.__resolveType({ kind: 'k9' })).toBe('Dog');
    expect(obj.resolvers.Animal.__resolveType({ kind: 'feline' })).toBe('Cat');
  });

  test('oneOf flow is unchanged: @oneOf input keyed by typeValue; branch inputs carry inherited + own fields; dispatcher intact', () => {
    const td = `
      type Shelter @model(key: "shelter") { id: ID! residents: [Critter!] }
      interface Critter @model(embed: true, typeField: "kind", oneOf: true) { kind: String! name: String! }
      type Pup implements Critter @model(embed: true, typeValue: "k9") { barkVolume: Int }
      type Kitty implements Critter @model(embed: true, typeValue: "feline") { livesLeft: Int }
    `;
    const schema = new Schema({}).merge(td);
    const $schema = schema.parse(); // internal model (drives the write-path unwrap/route/stamp)
    const executable = makeExecutableSchema(schema.api().toObject());

    const createInput = executable.getType('CritterInputCreate');
    expect(createInput.isOneOf).toBe(true);
    const branches = createInput.getFields();
    expect(branches).toHaveProperty('k9');
    expect(branches).toHaveProperty('feline');
    expect(String(branches.k9.type)).toBe('PupInputCreate');

    // The concrete branch input still contains the inherited interface field plus its own.
    const pupInput = executable.getType('PupInputCreate').getFields();
    expect(pupInput).toHaveProperty('name'); // inherited from Critter
    expect(pupInput).toHaveProperty('barkVolume'); // own

    // Internal dispatch wiring survives: oneOf flag + typeValue -> concrete-type registry.
    expect($schema.models.Critter.oneOf).toBe(true);
    expect($schema.models.Critter.typeMap).toMatchObject({ k9: 'Pup', feline: 'Kitty' });
  });
});

// Regression: a PERSISTED (key'd) interface whose variant declares an ENTITY-reference field.
// The interface model aggregates that field (for inputs/pipelines), but it is NOT on the interface
// GraphQL type — so its field resolver must be emitted on the CONCRETE type only, never the interface.
// Before the fix, SchemaApi emitted `Comp.tile` from the aggregated field set and makeExecutableSchema
// threw "Comp.tile defined in resolvers, but not in schema".
describe('persisted interface with entity-reference variant field', () => {
  const td = `
    interface Comp @model(key: "comp") { id: ID! type: CompType! }
    enum CompType { map item }
    type CompMap implements Comp @model(typeValue: "map") { tile: CompItem }
    type CompItem implements Comp @model(typeValue: "item") { label: String }
  `;

  test('variant entity-field resolver is on the concrete type, not the interface; schema builds', () => {
    const obj = new Schema({}).merge(td).api().toObject();
    expect(obj.resolvers.CompMap).toHaveProperty('tile'); // concrete type owns the relation resolver
    expect(obj.resolvers.Comp).not.toHaveProperty('tile'); // interface must NOT (tile isn't an interface field)
    expect(() => makeExecutableSchema(obj)).not.toThrow(); // threw before the fix
  });
});
