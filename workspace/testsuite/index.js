const { Schema, Resolver } = require('@coderich/autograph');
const schemaDef = require('./schema');
const TestSuite = require('./TestSuite');

exports.testSuite = TestSuite;

/**
 * Creates a minimal ObjectId shim for non-MongoDB drivers.
 *
 * The TestSuite uses `expect.any(ObjectId)`, `ObjectId.isValid()`, and
 * `new ObjectId(id)` throughout. MongoDB drivers can use the real ObjectId
 * class. Other drivers should call this and assign the result to global.ObjectId.
 *
 * IDs remain plain strings everywhere. The shim overrides Symbol.hasInstance
 * so that any non-empty string satisfies `instanceof ObjectId`, making
 * `expect.any(ObjectId)` pass without wrapping IDs in ObjectId instances.
 */
exports.createObjectIdShim = () => class ObjectId {
  constructor(id) {
    this._id = (id && typeof id === 'object' && '_id' in id) ? id._id : String(id);
  }

  toString() { return this._id; }
  valueOf() { return this._id; }

  static isValid(v) {
    const str = (v && typeof v === 'object' && '_id' in v) ? v._id : v;
    return typeof str === 'string' && str.length > 0;
  }

  static [Symbol.hasInstance](v) {
    if (v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === this.prototype) return true;
    return typeof v === 'string' && v.length > 0;
  }
};

exports.setup = ({ generator, dataSource }) => {
  const config = {
    namespace: 'autograph',
    generators: { default: generator },
    dataLoaders: { default: { cache: true } },
    dataSources: { default: dataSource },
    decorators: {
      default: `
        type default {
          id: ID! @field(key: "_id")
          createdAt: Date @field(serialize: createdAt, crud: r)
          updatedAt: Date @field(serialize: [timestamp, toDate], crud: r)
        }
      `,
    },
  };

  const schema = new Schema(config).framework().merge(schemaDef).decorate().api();
  const context = { network: { id: 'networkId' } };
  const resolver = new Resolver({ schema, context });

  return { context, schema, resolver };
};
