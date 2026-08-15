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

  test('the output type and the where input are untouched', () => {
    const { typeDefs: api } = generateApi(new Schema({}).merge(typeDefs).parse());
    expect(inputBlock(api, 'WidgetInputWhere')).toMatch(/user: /);
    expect(api).not.toMatch(/type Widget \{[\s\S]*?user: ID(?!!)/); // reads still promise non-null
  });
});
