const get = require('lodash.get');
const Util = require('@coderich/util');
const QueryBuilder = require('./QueryBuilder');
const { mergeDeep } = require('../service/AppService');

module.exports = class QueryResolver extends QueryBuilder {
  #model;
  #schema;
  #config;
  #context;
  #resolver;

  constructor(config) {
    const { schema, context, resolver, query } = config;
    super(config);
    this.#config = config;
    this.#schema = schema;
    this.#context = context;
    this.#resolver = resolver;
    this.#model = schema.models[query.model];
  }

  terminate() {
    const query = super.terminate();
    const { op, input } = query.toObject();

    // Resolve
    switch (op) {
      case 'findOne': case 'findMany': case 'count': case 'createOne': {
        return this.#resolver.resolve(query);
      }
      case 'createMany': {
        return this.#resolver.transaction(false).run(Promise.all(input.map(el => this.#resolver.match(this.#model.name).save(el))));
      }
      case 'updateOne': {
        return this.#get(query).then((doc) => {
          const merged = mergeDeep({}, doc, Util.unflatten(input, { safe: true }));
          return this.#resolver.resolve(query.clone({ doc, input: merged }));
        });
      }
      case 'updateMany': {
        return this.#find(query).then((docs) => {
          return this.#resolver.transaction(false).run(Promise.all(docs.map(doc => this.#resolver.match(this.#model.name).id(doc.id).save(input))));
        });
      }
      case 'pushOne': {
        return this.#get(query).then((doc) => {
          const [key] = Object.keys(input);
          const values = get(this.#model.transformers.input.transform(input), key);
          const $input = { [key]: (get(doc, key) || []).concat(...values) };
          return this.#resolver.match(this.#model.name).id(doc.id).save($input);
        });
      }
      case 'pushMany': {
        const [[key, values]] = Object.entries(input[0]);
        return this.#find(query).then((docs) => {
          return this.#resolver.transaction(false).run(Promise.all(docs.map(doc => this.#resolver.match(this.#model.name).id(doc.id).push(key, values))));
        });
      }
      case 'pullOne': {
        return this.#get(query).then((doc) => {
          const [key] = Object.keys(input);
          const values = get(this.#model.transformers.input.transform(input), key);
          const $input = { [key]: (get(doc, key) || []).filter(el => values.every(v => `${v}` !== `${el}`)) };
          return this.#resolver.match(this.#model.name).id(doc.id).save($input);
        });
      }
      case 'pullMany': {
        const [[key, values]] = Object.entries(input[0]);
        return this.#find(query).then((docs) => {
          return this.#resolver.transaction(false).run(Promise.all(docs.map(doc => this.#resolver.match(this.#model.name).id(doc.id).pull(key, values))));
        });
      }
      case 'spliceOne': {
        return this.#get(query).then((doc) => {
          const [key] = Object.keys(input);
          const [find, replace] = get(this.#model.transformers.input.transform(input), key);
          const $input = { [key]: (get(doc, key) || []).map(el => (`${el}` === `${find}` ? replace : el)) };
          return this.#resolver.match(this.#model.name).id(doc.id).save($input);
        });
      }
      case 'deleteOne': {
        return this.#get(query).then((doc) => {
          return this.#resolveReferentialIntegrity(query).then(() => {
            return this.#resolver.resolve(query.clone({ doc })).then(() => doc);
          });
        });
      }
      case 'deleteMany': {
        return this.#find(query).then((docs) => {
          return this.#resolver.transaction(false).run(Promise.all(docs.map(doc => this.#resolver.match(this.#model.name).id(doc.id).delete())));
        });
      }
      default: {
        throw new Error(`Unknown operation "${op}"`);
      }
    }
  }

  #get(query) {
    return this.#resolver.match(this.#model.name).id(query.toObject().id).one({ required: true });
  }

  #find(query) {
    return this.#resolver.resolve(query.clone({ op: 'findMany', key: `find${this.#model.name}`, crud: 'read', isMutation: false }));
  }

  #resolveReferentialIntegrity(query) {
    const { id } = query.toObject();
    const txn = this.#resolver.transaction(false);

    // if (this.#model.name === 'Person') console.log(this.#model.referentialIntegrity);
    return txn.run(Util.promiseChain(this.#model.referentialIntegrity.map(({ model, field, fieldRef, isArray, op }) => () => {
      const fieldStr = fieldRef ? `${field}.${fieldRef}` : `${field.name}`;
      const $where = { [fieldStr]: id };

      switch (op) {
        case 'cascade': return isArray ? txn.match(model).where($where).pull(fieldStr, id) : txn.match(model).where($where).remove();
        case 'nullify': return txn.match(model).where($where).save({ [fieldStr]: null });
        case 'restrict': return txn.match(model).where($where).count().then(count => (count ? Promise.reject(new Error('Restricted')) : count));
        case 'defer': return Promise.resolve(); // Used for embedded models (could be improved)
        default: throw new Error(`Unknown onDelete operator: '${op}'`);
      }
    })));
  }
};
