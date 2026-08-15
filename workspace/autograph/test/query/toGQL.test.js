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
    expect(query).toContain('author { id }'); // relation reduced to its pk — the client flattens it to a bare FK
    expect(query).not.toContain('author { id name }'); // NOT the related model's scalars
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

  test('a relation named in select is still pk-only', () => {
    const { query } = build('Book').select('title', 'author').many().toGQL();
    isValidGQL(query);
    expect(query).toContain('node { title author { id } }');
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

// The selection contract, in full. The wire selection matches the shape the LOCAL resolver returns —
// the stored document: scalars and enums by name, embedded types in full, and a relation reduced to
// its pk (which the remote client flattens back to a bare FK). Virtual (@link) fields are not stored,
// so the default selection omits them; naming one in `select` opts it in, still pk-only.
describe('Query.toGQL selection contract', () => {
  let schema;
  const build = model => new QueryBuilder({ schema, query: { model }, context: {} });
  const isValidGQL = gql => expect(() => parse(gql)).not.toThrow();
  const selectionOf = model => build(model).id('x').one().toGQL().query;

  const richTypeDefs = `
    enum Genre { FICTION NONFICTION }
    type Inner { code: String }
    type Loc { lat: String lng: String inner: Inner }
    type Shelf @model(pk: "key") {
      key: ID! @field(key: "_id")
      label: String
    }
    type Library @model {
      id: ID! @field(key: "_id")
      name: String
      genre: Genre
      loc: Loc
      shelf: Shelf
      books: [Book] @field(connection: true)
      featured: [Book] @link(by: "author")
    }
  `;

  beforeAll(() => {
    schema = new Schema({}).framework().merge({ typeDefs }).merge({ typeDefs: richTypeDefs }).decorate().api().parse();
  });

  test('a relation selects the pk of ITS model — pkField is not always "id"', () => {
    const query = selectionOf('Library');
    isValidGQL(query);
    expect(query).toContain('shelf { key }'); // Shelf declares @model(pk: "key")
  });

  test('a connection-marked relation rides the Connection shape, pk-only', () => {
    const query = selectionOf('Library');
    isValidGQL(query);
    expect(query).toContain('books { edges { node { id } } }');
  });

  test('enums are selected like scalars', () => {
    const query = selectionOf('Library');
    isValidGQL(query);
    expect(query).toMatch(/node \{[^}]*genre|genre/);
    expect(query).toContain('genre');
  });

  test('an embedded type is expanded in full, recursively', () => {
    const query = selectionOf('Library');
    isValidGQL(query);
    expect(query).toContain('loc { lat lng inner { code } }');
  });

  test('a virtual (@link) field is omitted from the default selection', () => {
    const query = selectionOf('Library');
    expect(query).not.toContain('featured');
  });

  test('a virtual field named in select is honored, pk-only', () => {
    const { query } = build('Library').select('name', 'featured').many().toGQL();
    isValidGQL(query);
    expect(query).toContain('node { name featured { id } }');
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
