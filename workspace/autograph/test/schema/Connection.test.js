const { makeExecutableSchema } = require('@graphql-tools/schema');
const Schema = require('../../src/schema/Schema');

// Connection/Edge pairs used to be emitted for every readable model, which meant every embedded or
// nested type carried a Connection + Edge that no field and no root query could ever reach. They are
// now gated on actual reachability, which is two things and only two:
//
//   1. a root `find${model}` field  (entity models with `r` in crud)
//   2. a `@field(connection: true)` field pointing at the model, which Schema#rewriteConnections
//      retypes in place to `${model}Connection`
//
// AuditLog below is the case that makes (2) load-bearing: `crud: "cud"` keeps it out of the root
// query surface entirely, so gating on that surface alone would drop a Connection that Person.logs
// still references — an unbuildable schema, not a quiet regression.
const typeDefs = `
  type Person @model(key: "person") {
    id: ID!
    name: String!
    sso: SingleSignOn
    friends: [Person] @field(connection: true)
    logs: [AuditLog] @field(connection: true)
  }

  type SingleSignOn @model(embed: true) {
    provider: String
    url: String
  }

  type AuditLog @model(key: "auditlog", crud: "cud") {
    id: ID!
    message: String
  }
`;

describe('Connection type generation', () => {
  let executable, resolvers;

  beforeAll(() => {
    const obj = new Schema({}).merge(typeDefs).api().toObject();
    resolvers = obj.resolvers;
    executable = makeExecutableSchema(obj);
  });

  test('emits Connection/Edge for a model with a root find field', () => {
    expect(executable.getType('PersonConnection')).toBeDefined();
    expect(executable.getType('PersonEdge')).toBeDefined();
    expect(executable.getType('Query').getFields()).toHaveProperty('findPerson');
  });

  test('emits no Connection/Edge for a type nothing can reach as a list', () => {
    expect(executable.getType('SingleSignOnConnection')).toBeUndefined();
    expect(executable.getType('SingleSignOnEdge')).toBeUndefined();
  });

  test('still emits where/sort for that same unreachable type', () => {
    // The sibling half of the generator: nested where/sort ARE reachable, because parent input
    // types reference them. Narrowing these too would silently remove real query surface.
    expect(executable.getType('SingleSignOnInputWhere')).toBeDefined();
    expect(executable.getType('SingleSignOnInputSort')).toBeDefined();
    expect(executable.getType('PersonInputWhere').getFields()).toHaveProperty('sso');
    expect(String(executable.getType('PersonInputWhere').getFields().sso.type)).toBe('SingleSignOnInputWhere');
  });

  test('emits Connection/Edge for a connection-field target with no root find field', () => {
    expect(executable.getType('Query').getFields()).not.toHaveProperty('findAuditLog');
    expect(executable.getType('AuditLogConnection')).toBeDefined();
    expect(executable.getType('AuditLogEdge')).toBeDefined();
    expect(String(executable.getType('Person').getFields().logs.type)).toBe('AuditLogConnection');
  });

  test('gives every emitted Connection its count/edges/pageInfo resolvers', () => {
    // Keyed off the same list as the types. When these were keyed off the root query surface
    // instead, AuditLogConnection was emitted with no resolvers at all and Person.logs handed the
    // caller the raw thunks in place of data.
    ['PersonConnection', 'AuditLogConnection'].forEach((name) => {
      expect(resolvers[name]).toBeDefined();
      expect(Object.keys(resolvers[name]).sort()).toEqual(['count', 'edges', 'pageInfo']);
    });
    expect(resolvers.SingleSignOnConnection).toBeUndefined();
  });
});
