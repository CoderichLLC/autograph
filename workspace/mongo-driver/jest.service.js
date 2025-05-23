global.ObjectId = require('mongodb').ObjectId;
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { setup } = require('@coderich/autograph-db-tests');
const MongoClient = require('./src/MongoDriver');

exports.setup = async () => {
  // Start mongo server
  global.mongoServer = await MongoMemoryReplSet.create({
    replSet: { storageEngine: 'wiredTiger' },
  });

  // Configure clients
  global.mongoClient = new MongoClient({
    uri: global.mongoServer.getUri(),
    options: { ignoreUndefined: false, minPoolSize: 3 },
    query: { collation: { locale: 'en', strength: 2 }, readPreference: 'primary' },
    session: { retryWrites: true, readPreference: { mode: 'primary' }, readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } },
    transaction: { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } },
  });

  // Autograph
  Object.assign(global, setup({
    generator: ({ value }) => {
      if (value instanceof global.ObjectId) return value;

      try {
        const id = new global.ObjectId(value);
        return id;
      } catch (e) {
        return value;
      }
    },
    dataSource: {
      supports: ['transactions'],
      client: global.mongoClient,
    },
  }));

  // Indexes
  await Promise.all(global.schema.parse().indexes.map(({ key, name, type, on }) => {
    const fields = on.reduce((prev, field) => Object.assign(prev, { [field]: 1 }), {});
    return global.mongoClient.collection(key).createIndex(fields, { name, [type]: true });
  }));
};
