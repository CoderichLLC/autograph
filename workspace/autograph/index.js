const Schema = require('./src/schema/Schema');
const Resolver = require('./src/data/Resolver');
const Pipeline = require('./src/data/Pipeline');
const Emitter = require('./src/data/Emitter');
const apolloPlugin = require('./src/data/ApolloPlugin');

module.exports = {
  Schema,
  Resolver,
  Pipeline,
  Emitter,
  apolloPlugin,
};
