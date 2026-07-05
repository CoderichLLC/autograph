const Schema = require('../../src/schema/Schema');
const Pipeline = require('../../src/data/Pipeline');

// DSL reference validation — the SDL references things GraphQL itself cannot verify (pipeline
// names, @link(by:) targets, @index fields). These must fail LOUDLY at parse (boot) time with
// the model.field named, never as a cryptic TypeError on the first production request.

// Fresh config per parse — Schema instances mutate their config (decorator AST caching), so
// sharing one object across tests bleeds state between otherwise-independent schemas.
const config = () => ({
  decorators: {
    default: `
      type decorator {
        id: ID! @field(key: "_id")
      }
    `,
  },
});

const parse = typeDefs => () => new Schema(config()).merge(typeDefs).decorate().parse();

describe('Schema DSL reference validation (parse-time, loud)', () => {
  test('a typo\'d pipeline reference fails at parse — naming the model, field, stage, and fix', () => {
    expect(parse(`
      type Person @model {
        name: String @field(validate: bookNmae)
      }
    `)).toThrow(/Person\.name — unknown pipeline "bookNmae" \(validate\).*Pipeline\.define\('bookNmae'/);
  });

  test('unknown pipelines inside ARRAY stage assignments are caught too', () => {
    expect(parse(`
      type Person @model {
        name: String @field(serialize: [toLowerCase, notAThing])
      }
    `)).toThrow(/Person\.name — unknown pipeline "notAThing" \(serialize\)/);
  });

  test('ALL dangling references aggregate into ONE error — fix everything in one pass', () => {
    let error;
    try {
      parse(`
        type Person @model {
          name: String @field(validate: nopeOne)
          age: Int @field(normalize: nopeTwo)
        }
      `)();
    } catch (e) {
      error = e;
    }
    expect(error.message).toMatch(/unknown pipeline "nopeOne" \(validate\)/);
    expect(error.message).toMatch(/unknown pipeline "nopeTwo" \(normalize\)/);
  });

  test('a pipeline defined BEFORE parse validates cleanly — define-then-parse is the contract', () => {
    Pipeline.define('definitelyDefined', ({ value }) => value);
    expect(parse(`
      type Person @model {
        name: String @field(validate: definitelyDefined)
      }
    `)).not.toThrow();
  });

  test('@link(by:) naming a nonexistent field on the target model fails descriptively', () => {
    expect(parse(`
      type Person @model {
        name: String
        books: [Book] @link(by: writer)
      }
      type Book @model {
        name: String
        author: Person
      }
    `)).toThrow(/Person\.books — @link\(by: "writer"\) does not name a field on Book/);
  });

  test('@index(on:) naming a nonexistent field fails descriptively', () => {
    expect(parse(`
      type Person @model @index(name: "uix_person_bogus", type: unique, on: [nickname]) {
        name: String
      }
    `)).toThrow(/@index "uix_person_bogus" on Person — "nickname" does not name a field on Person/);
  });
});
