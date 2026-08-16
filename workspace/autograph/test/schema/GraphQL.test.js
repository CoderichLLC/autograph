const { graphql } = require('graphql');
const { makeExecutableSchema } = require('@graphql-tools/schema');

describe('GraphQL', () => {
  let xschema, $schema, context, resolver;
  let person, book;

  beforeAll(async () => {
    ({ $schema, context, resolver } = global);
    xschema = makeExecutableSchema($schema.toObject());
  });

  test('create', async () => {
    const [{ errors, data }] = await Promise.all(['rich', 'anne'].map((name) => {
      return graphql({
        schema: xschema,
        contextValue: context,
        source: `
          mutation ($input: PersonInputCreate!) {
            createPerson(input: $input) {
              id
            }
          }
        `,
        variableValues: {
          input: { name, emailAddress: 'email@gmail.com' },
        },
      });
    }));
    expect(errors).not.toBeDefined();
    expect(data).toBeDefined();
    person = data.createPerson;

    // Let's quickly create some FK data
    book = await resolver.match('Book').save({ name: 'book', price: 10, author: person.id });
  });

  test('getPerson (authored connection)', async () => {
    expect(await graphql({
      schema: xschema,
      contextValue: context,
      source: `
        query {
          getPerson(id: "${person.id}") {
            id
            authored {
              edges {
                node {
                  id
                  name
                }
              }
            }
          }
        }
      `,
    })).toEqual({
      errors: undefined,
      data: {
        getPerson: {
          id: `${person.id}`,
          authored: {
            edges: [{
              node: {
                id: expect.anything(),
                name: 'Book', // toTitleCase
              },
            }],
          },
        },
      },
    });
  });

  test('getBook (author)', async () => {
    expect(await graphql({
      schema: xschema,
      contextValue: context,
      source: `
        query {
          getBook(id: "${book.id}") {
            id
            author { name }
          }
        }
      `,
    })).toEqual({
      errors: undefined,
      data: {
        getBook: {
          id: `${book.id}`,
          author: { name: 'rich' },
        },
      },
    });
  });

  test('find', async () => {
    expect(await graphql({
      schema: xschema,
      contextValue: context,
      source: `
        query {
          findPerson {
            count
            edges {
              cursor
              node { id name }
            }
            pageInfo { startCursor endCursor hasPreviousPage hasNextPage }
          }
        }
      `,
    })).toEqual({
      errors: undefined,
      data: {
        findPerson: {
          count: 2,
          pageInfo: null,
          edges: expect.arrayContaining([{
            cursor: null,
            node: {
              id: `${person.id}`,
              name: 'rich',
            },
          }, {
            cursor: null,
            node: {
              id: expect.anything(),
              name: 'anne',
            },
          }]),
        },
      },
    });
  });

  test('find (where)', async () => {
    expect(await graphql({
      schema: xschema,
      contextValue: context,
      source: `
        query {
          findPerson(where: {
            name: "anne"
          }) {
            count
            edges {
              cursor
              node { id name }
            }
            pageInfo { startCursor endCursor hasPreviousPage hasNextPage }
          }
        }
      `,
    })).toEqual({
      errors: undefined,
      data: {
        findPerson: {
          count: 1,
          pageInfo: null,
          edges: expect.arrayContaining([{
            cursor: null,
            node: {
              id: expect.anything(),
              name: 'anne',
            },
          }]),
        },
      },
    });
  });

  // The `_` VOCABULARY SLOT on the typed where-input: the full where IR rides it (operators,
  // compounds — inexpressible as typed input fields since `$` is not a legal GraphQL name), the
  // server LIFTS it into an implicit AND with its typed siblings, and the query boundary
  // validates its content like any other where. NOTE the slot's content must travel as a
  // VARIABLE — `$`-keys are illegal in document literals too, so an inline `{ _: { age: { $exists:
  // false } } }` cannot even parse; variables are JSON and carry it fine.
  test('find (where `_` slot): operators cross the typed input', async () => {
    const { errors, data } = await graphql({
      schema: xschema,
      contextValue: context,
      source: 'query ($where: PersonInputWhere) { findPerson(where: $where) { count edges { node { name } } } }',
      variableValues: { where: { _: { age: { $exists: false } } } }, // neither person was created with an age
    });
    expect(errors).not.toBeDefined();
    expect(data.findPerson.count).toBe(2);
  });

  test('find (where `_` slot): the slot ANDs with its typed siblings', async () => {
    const { errors, data } = await graphql({
      schema: xschema,
      contextValue: context,
      source: 'query ($where: PersonInputWhere) { findPerson(where: $where) { count edges { node { name } } } }',
      variableValues: { where: { name: 'anne', _: { age: { $exists: false } } } },
    });
    expect(errors).not.toBeDefined();
    expect(data.findPerson.count).toBe(1);
    expect(data.findPerson.edges[0].node.name).toBe('anne');
  });

  test('find (where `_` slot): slot content is boundary-validated like any other where', async () => {
    const { errors } = await graphql({
      schema: xschema,
      contextValue: context,
      source: 'query ($where: PersonInputWhere) { findPerson(where: $where) { count } }',
      variableValues: { where: { _: { bogus: 1 } } },
    });
    expect(errors?.[0]?.message).toMatch(/Unknown where field "bogus"/);
  });

  test('find (sort, cursorPaginating)', async () => {
    expect(await graphql({
      schema: xschema,
      contextValue: context,
      source: `
        query {
          findPerson(
            first: 1
            sortBy: { name: asc }
          ) {
            count
            edges {
              cursor
              node { id name }
            }
            pageInfo { startCursor endCursor hasPreviousPage hasNextPage }
          }
        }
      `,
    })).toEqual({
      errors: undefined,
      data: {
        findPerson: {
          count: 2,
          pageInfo: {
            startCursor: expect.anything(),
            endCursor: expect.anything(),
            hasPreviousPage: false,
            hasNextPage: true,
          },
          edges: [{
            cursor: expect.anything(),
            node: {
              id: expect.anything(),
              name: 'anne',
            },
          }],
        },
      },
    });
  });

  test('update', async () => {
    expect(await graphql({
      schema: xschema,
      contextValue: context,
      source: `
        mutation ($id: ID!, $input: PersonInputUpdate) {
          updatePerson(id: $id, input: $input) {
            id
            name
          }
        }
      `,
      variableValues: {
        id: person.id,
        input: { name: 'richie' },
      },
    })).toEqual({
      errors: undefined,
      data: {
        updatePerson: {
          id: `${person.id}`,
          name: 'richie',
        },
      },
    });
  });

  test('delete', async () => {
    expect(await graphql({
      schema: xschema,
      contextValue: context,
      source: `
        mutation ($id: ID!) {
          deletePerson(id: $id) {
            id
            name
          }
        }
      `,
      variableValues: { id: person.id },
    })).toEqual({
      errors: undefined,
      data: {
        deletePerson: {
          id: `${person.id}`,
          name: 'richie',
        },
      },
    });
  });
});
