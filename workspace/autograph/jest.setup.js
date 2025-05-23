global.ObjectId = require('@coderich/autograph-mongodb').ObjectId;
const { setup, createIndexes } = require('./jest.service');

let schema, context, resolver;
let mongoClient = { disconnect: () => Promise.resolve() };
let mongoServer = { stop: () => Promise.resolve() };

// Extend jest!
expect.extend({
  thunk: (val, fn) => {
    const pass = Boolean(fn(val));
    return { pass };
  },
  multiplex: (val, ...expectations) => {
    try {
      expectations.flat().forEach((expectation) => {
        expectation(val);
      });
      return { pass: true };
    } catch ({ message }) {
      return { message, pass: false };
    }
  },
});

beforeAll(async () => {
  ({ resolver, schema, context, mongoClient, mongoServer } = await setup({ typeDefs: 'type Library { id: ID }' }));
  global.$schema = schema;
  global.context = context;
  global.schema = schema.parse();
  global.resolver = resolver;
  global.mongoClient = mongoClient;
  await createIndexes(mongoClient, global.schema.indexes);
});

afterAll(() => {
  return Promise.all([
    mongoClient.disconnect(),
    mongoServer.stop(),
  ]);
});
