const { ObjectId } = require('mongodb');
const Validator = require('validator');
const { makeExecutableSchema } = require('@graphql-tools/schema');
const MongoClient = require('@coderich/autograph-mongodb');
const Pipeline = require('../src/data/Pipeline');

Pipeline.define('bookName', Pipeline.Deny('The Bible'));
Pipeline.define('bookPrice', Pipeline.Range(0, 100));
Pipeline.define('artComment', Pipeline.Allow('yay', 'great', 'boo'));
Pipeline.define('colors', Pipeline.Allow('blue', 'red', 'green', 'purple'));
Pipeline.define('networkID', ({ context }) => context.network.id, { ignoreNull: false });
Pipeline.define('email', ({ value }) => {
  if (!Validator.isEmail(value)) throw new Error('Invalid email');
});

module.exports = ({ uri }) => ({
  namespace: 'autograph',
  makeExecutableSchema,
  generators: {
    default: ({ value }) => {
      if (value instanceof ObjectId) return value;

      try {
        const id = new ObjectId(value);
        return id;
      } catch (e) {
        return value;
      }
    },
  },
  dataLoaders: {
    default: {
      cache: true,
    },
  },
  dataSources: {
    default: {
      supports: ['transactions'],
      client: new MongoClient({
        uri,
        options: { useNewUrlParser: true, useUnifiedTopology: true, ignoreUndefined: false, minPoolSize: 3 },
        query: { collation: { locale: 'en', strength: 2 }, readPreference: 'primary' },
        session: { retryWrites: true, readPreference: { mode: 'primary' }, readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } },
        transaction: { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } },
      }),
    },
  },
  decorators: {
    default: `
      type default {
        id: ID! @field(key: "_id")
        createdAt: Date @field(serialize: createdAt, crud: r)
        updatedAt: Date @field(serialize: [timestamp, toDate], crud: r)
      }
    `,
  },
});
