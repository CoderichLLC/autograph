const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { setup } = require('@coderich/autograph-db-tests');
const MongoClient = require('@coderich/autograph-mongodb');

exports.setup = async (mergeConfig) => {
  // Start mongo server
  const mongoServer = await MongoMemoryReplSet.create({ replSet: { storageEngine: 'wiredTiger' } });

  // Define client
  const mongoClient = new MongoClient({
    uri: mongoServer.getUri(),
    options: { ignoreUndefined: false, minPoolSize: 3 },
    query: { collation: { locale: 'en', strength: 2 }, readPreference: 'primary' },
    session: { retryWrites: true, readPreference: { mode: 'primary' }, readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } },
    transaction: { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } },
  });

  const { context, schema, resolver } = setup({
    generator: ({ value }) => {
      if (value instanceof MongoClient.ObjectId) return value;

      try {
        const id = new MongoClient.ObjectId(value);
        return id;
      } catch {
        return value;
      }
    },
    dataSource: {
      supports: ['transactions'],
      client: mongoClient,
    },
  });

  return { resolver, schema, mongoClient, mongoServer, context };
};

exports.createIndexes = (mongoClient, indexes) => {
  return Promise.all(indexes.map(({ key, name, type, on }) => {
    const fields = on.reduce((prev, field) => Object.assign(prev, { [field]: 1 }), {});
    return mongoClient.collection(key).createIndex(fields, { name, [type]: true });
  }));
};
