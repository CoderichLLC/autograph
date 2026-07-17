const { parse, graphql } = require('graphql');
const { makeExecutableSchema } = require('@graphql-tools/schema');
const { Schema } = require('../../index');
const QueryBuilder = require('../../src/query/QueryBuilder');

// A self-contained schema (no datasource needed — toGQL is pure IR → GraphQL serialization).
const typeDefs = `
  type Author @model {
    id: ID! @field(key: "_id")
    name: String
    books: [Book]
  }
  type Book @model {
    id: ID! @field(key: "_id")
    title: String
    pages: Int
    author: Author
  }
`;

describe('Query.toGQL', () => {
  let schema;
  const build = model => new QueryBuilder({ schema, query: { model }, context: {} });
  const isValidGQL = gql => expect(() => parse(gql)).not.toThrow();

  beforeAll(() => {
    schema = new Schema({}).framework().merge({ typeDefs }).decorate().api().parse();
  });

  test('findOne by id → getModel(id) with a scalar selection', () => {
    const { query, variables } = build('Book').id('abc123').one().toGQL();
    isValidGQL(query);
    expect(query).toMatch(/^query GetBook\(\$id: ID!\) \{ getBook\(id: \$id\) \{/);
    expect(query).toContain('id title pages'); // Book scalars
    expect(query).toContain('author { id name }'); // relation expanded ONE level (Author scalars)
    expect(variables).toEqual({ id: 'abc123' });
  });

  test('findOne by where → findModel(where, first: 1) taking the first node', () => {
    const { query, variables } = build('Book').where({ title: 'Dune' }).one().toGQL();
    isValidGQL(query);
    expect(query).toMatch(/findBook\(where: \$where, first: \$first\) \{ edges \{ node \{/);
    expect(variables).toEqual({ where: { title: 'Dune' }, first: 1 });
  });

  test('findMany → a Connection ({ count edges { node } })', () => {
    const { query, variables } = build('Book').where({ pages: 100 }).sortBy({ title: 'asc' }).many().toGQL();
    isValidGQL(query);
    expect(query).toMatch(/findBook\(where: \$where, sortBy: \$sortBy\) \{ count edges \{ node \{/);
    expect(query).toContain('$where: BookInputWhere');
    expect(query).toContain('$sortBy: BookInputSort');
    expect(variables).toEqual({ where: { pages: 100 }, sortBy: { title: 'asc' } });
  });

  test('count → findModel(where) { count }', () => {
    const { query, variables } = build('Book').where({ pages: 100 }).count().toGQL();
    isValidGQL(query);
    expect(query).toContain('findBook(where: $where) { count }');
    expect(variables).toEqual({ where: { pages: 100 } });
  });

  test('select narrows the selection set (and drops the relation)', () => {
    const { query } = build('Book').select('title', 'pages').many().toGQL();
    isValidGQL(query);
    expect(query).toContain('node { title pages }');
    expect(query).not.toContain('author');
  });

  test('create → mutation createModel(input)', () => {
    const { query, variables } = build('Book').save({ title: 'Dune', pages: 412 }).toGQL();
    isValidGQL(query);
    expect(query).toMatch(/^mutation CreateBook\(\$input: BookInputCreate!\) \{ createBook\(input: \$input\) \{/);
    expect(variables).toEqual({ input: { title: 'Dune', pages: 412 } });
  });

  test('update → mutation updateModel(id, input)', () => {
    const { query, variables } = build('Book').id('b1').save({ pages: 500 }).toGQL();
    isValidGQL(query);
    expect(query).toMatch(/updateBook\(id: \$id, input: \$input\)/);
    expect(query).toContain('$input: BookInputUpdate');
    expect(variables).toEqual({ id: 'b1', input: { pages: 500 } });
  });

  test('delete → mutation deleteModel(id)', () => {
    const { query, variables } = build('Book').id('b1').delete().toGQL();
    isValidGQL(query);
    expect(query).toMatch(/^mutation DeleteBook\(\$id: ID!\) \{ deleteBook\(id: \$id\) \{/);
    expect(variables).toEqual({ id: 'b1' });
  });

  test('omits undefined arguments entirely', () => {
    const { query, variables } = build('Book').many().toGQL();
    isValidGQL(query);
    expect(query).not.toContain('where');
    expect(query).toMatch(/find[Bb]ook \{ count edges/); // no ()
    expect(variables).toEqual({});
  });
});

// Round-trip: build a Query, toGQL() it, then EXECUTE that GraphQL against the real (mongo-backed)
// schema from the shared harness — proving the output isn't merely valid syntax, but a query the
// Autograph server actually accepts and resolves to the right data.
describe('Query.toGQL (round-trip against the real API)', () => {
  let xschema; let context; let resolver; let parsed; let personId;

  const exec = ({ query, variables }) => graphql({ schema: xschema, contextValue: context, source: query, variableValues: variables });
  const qb = model => new QueryBuilder({ schema: parsed, resolver, context, query: { model } });

  beforeAll(async () => {
    ({ context, resolver } = global);
    parsed = global.schema;
    xschema = makeExecutableSchema(global.$schema.toObject());
    const { data } = await exec(qb('Person').select('id', 'name').save({ name: 'toGQL-Rich', emailAddress: 'togql-rich@example.com' }).toGQL());
    personId = data.createPerson.id;
  });

  test('getPerson: toGQL round-trips to the seeded record', async () => {
    const { data, errors } = await exec(qb('Person').id(personId).select('id', 'name').one().toGQL());
    expect(errors).toBeUndefined();
    expect(data.getPerson).toEqual({ id: personId, name: 'togql-rich' });
  });

  test('findPerson: toGQL round-trips to a connection containing the record', async () => {
    const { data, errors } = await exec(qb('Person').where({ name: 'toGQL-Rich' }).select('id', 'name').many().toGQL());
    expect(errors).toBeUndefined();
    expect(data.findPerson.edges.map(e => e.node.name)).toContain('togql-rich'); // Person.name lowercases (a field transform)
  });

  test('createPerson: toGQL round-trips a mutation', async () => {
    const { data, errors } = await exec(qb('Person').select('id', 'name').save({ name: 'toGQL-Created', emailAddress: 'togql-created@example.com' }).toGQL());
    expect(errors).toBeUndefined();
    expect(data.createPerson.name).toBe('togql-created');
  });

  test('updatePerson: toGQL round-trips an update', async () => {
    const { data, errors } = await exec(qb('Person').id(personId).select('id', 'name').save({ name: 'toGQL-Renamed' }).toGQL());
    expect(errors).toBeUndefined();
    expect(data.updatePerson.name).toBe('togql-renamed');
  });
});
