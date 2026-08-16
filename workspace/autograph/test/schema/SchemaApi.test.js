const Schema = require('../../src/schema/Schema');
const Pipeline = require('../../src/data/Pipeline');
const { generateApi } = require('../../src/schema/SchemaApi');

// The generated Input{Create} must not REQUIRE what the server itself supplies. `defaultValue`
// already gets this treatment (a field with @field(default:) is optional in InputCreate); an
// `instruct` pipeline is the same promise made in code — it runs on every create/update, even when
// the field is absent from the payload (the parser seeds `defaults[field] = undefined` for exactly
// that reason). Typing it `ID!` anyway means GraphQL variable coercion refuses the mutation before
// any pipeline can run, so a remote client can NEVER create the document — measured live: the
// dogfood's `user: User! @field(instruct: userId)` made every createContactGroupEvent fail with
// `Field "user" of required type "ID!" was not provided`, while the same save() worked in-process
// (no GraphQL layer between builder and pipeline). The field stays required at the STORAGE
// contract: the `required` validate rule still refuses a create where the pipeline produced
// nothing (e.g. an anonymous caller).
describe('generated inputs vs server-supplied fields', () => {
  beforeAll(() => {
    Pipeline.define('apiTestStampUser', ({ value, context }) => value ?? context.user?.id, { ignoreNull: false });
  });

  const typeDefs = `
    scalar AutoGraphDateTime

    type Widget @model {
      name: String!
      user: ID! @field(instruct: apiTestStampUser)
      count: Int
    }
  `;

  const inputBlock = (api, name) => api.match(new RegExp(`input ${name} \\{([\\s\\S]*?)\\}`))[1];

  test('a required field carrying an instruct pipeline is OPTIONAL in InputCreate', () => {
    const { typeDefs: api } = generateApi(new Schema({}).merge(typeDefs).parse());
    const create = inputBlock(api, 'WidgetInputCreate');
    expect(create).toMatch(/user: ID(?!!)/); // the server supplies it — coercion must not refuse first
    expect(create).toMatch(/name: String!/); // a plain required field is still the caller's to provide
  });

  // `@model(meta:)` adds the meta ARGUMENT and nothing else. An earlier revision also relaxed the
  // create input to nullable, and it was rejected: meta is an untyped escape hatch whose presence
  // promises nothing about who fills the input — unlike `default`/`instruct`, which are per-field,
  // generator-verifiable server-supplies-it declarations. A wholly server-driven create (clone)
  // belongs to a custom operation, not a bent create.
  test('declaring @model(meta:) adds the meta argument; the create input stays required', () => {
    const metaDefs = `
      scalar AutoGraphDateTime
      scalar Mixed

      type Gadget @model(meta: Mixed) {
        name: String!
      }
    `;
    const { typeDefs: api } = generateApi(new Schema({}).merge(metaDefs).parse());
    expect(api).toMatch(/createGadget\(input: GadgetInputCreate! meta: Mixed\)/);
    expect(api).toMatch(/updateGadget\(id: ID! input: GadgetInputUpdate meta: Mixed\)/);
    expect(api).toMatch(/deleteGadget\(id: ID! meta: Mixed\)/);
  });

  // The WHERE surface: the typed `<Model>InputWhere` STAYS — external clients hard-code its name
  // in variable declarations (`query ($where: PersonInputWhere)`), and its fields are what
  // introspection documents — plus ONE optional `_: AutoGraphMixed` member: the vocabulary SLOT.
  // GraphQL's type system cannot carry the where IR (`$` is not a legal field name; a relation
  // operand is bare-id | array | operator-object | nested-where, which inputs can't union), so
  // the slot is where the FULL grammar rides — validated at the query boundary like everything
  // else, and lifted server-side into an implicit AND with its typed siblings. Strictly additive:
  // nothing existing changes shape, meaning, or name.
  test('the where argument stays typed, and every InputWhere carries the `_` vocabulary slot', () => {
    const { typeDefs: api } = generateApi(new Schema({}).merge(typeDefs).parse());
    expect(api).toMatch(/findWidget\([^)]*where: WidgetInputWhere/);
    expect(inputBlock(api, 'WidgetInputWhere')).toMatch(/_: AutoGraphMixed/);
    expect(inputBlock(api, 'WidgetInputWhere')).toMatch(/user: /); // typed fields untouched
  });

  test('the subscription filter keeps its typed where, slot included', () => {
    const subDefs = `
      scalar AutoGraphDateTime

      type Thing @model(crud: "cruds") {
        name: String
      }
    `;
    const { typeDefs: api } = generateApi(new Schema({}).merge(subDefs).parse());
    expect(api).toMatch(/where: ThingSubscriptionInputWhere! = \{\}/);
    expect(inputBlock(api, 'ThingSubscriptionInputWhere')).toMatch(/_: AutoGraphMixed/);
    expect(api).toMatch(/input ThingInputSort/); // sort stays typed — navigational grammar, no slot needed
    expect(inputBlock(api, 'ThingInputSort')).not.toMatch(/_: /);
  });

  // `_` is WIRE vocabulary, not an author field name — a model that declares it would collide
  // with the slot on its own where-input, so the reservation is enforced loudly at parse.
  test('a model field named `_` is refused at parse — the slot name is reserved', () => {
    expect(() => new Schema({}).merge(`
      type Bad @model {
        _: String
      }
    `).parse()).toThrow(/"_".*reserved/s);
  });

  test('the output type is untouched', () => {
    const { typeDefs: api } = generateApi(new Schema({}).merge(typeDefs).parse());
    expect(api).not.toMatch(/type Widget \{[\s\S]*?user: ID(?!!)/); // reads still promise non-null
  });
});
