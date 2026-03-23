const Boom = require('@hapi/boom');
const get = require('lodash.get');
const Util = require('@coderich/util');
const uniqWith = require('lodash.uniqwith');
const { hashObject } = require('../service/AppService');

module.exports = class Pipeline {
  constructor() {
    throw new Error('Pipeline is a singleton; use the static {define|factory} methods');
  }

  static define(name, factory, options = {}) {
    // A factory must be a function
    if (typeof factory !== 'function') throw new Error(`Pipeline definition for "${name}" must be a function`);

    // Determine options; which may come from the factory function
    const { ignoreNull = true, itemize = true, configurable = false } = { ...factory.options, ...options };

    const wrapper = Object.defineProperty((args) => {
      try {
        if (ignoreNull && args.value == null) return args.value;
        if (ignoreNull && itemize) return Util.map(args.value, value => Util.uvl(factory({ ...args, value }), value));
        return Util.uvl(factory(args), args.value);
      } catch (e) {
        const { data = {} } = e;
        throw Boom.boomify(e, { data: { ...args, ...data } });
      }
    }, 'name', { value: name });

    // Attach enumerable method to the Pipeline
    return Object.defineProperty(Pipeline, name, {
      value: wrapper,
      configurable,
      enumerable: true,
    })[name];
  }

  static factory(name, thunk, options = {}) {
    if (typeof thunk !== 'function') throw new Error(`Pipeline factory for "${name}" must be a thunk`);
    if (typeof thunk() !== 'function') throw new Error(`Factory thunk() for "${name}" must return a function`);
    return Object.defineProperty(Pipeline, name, { value: (...args) => Object.defineProperty(thunk(...args), 'options', { value: options }) })[name];
  }

  static createPresets() {
    // Built-In Javascript String Transformers
    const jsStringTransformers = ['toLowerCase', 'toUpperCase', 'toString', 'trim', 'trimEnd', 'trimStart'];
    jsStringTransformers.forEach(name => Pipeline.define(`${name}`, ({ value }) => String(value)[name]()));

    // Additional Transformers
    Pipeline.define('toArray', ({ value }) => (Array.isArray(value) ? value : [value]), { itemize: false });
    Pipeline.define('toDate', ({ value }) => new Date(value), { configurable: true });
    Pipeline.define('createdAt', ({ query, model, value }) => value || (query.crud === 'create' || model.isEmbedded ? new Date() : undefined), { ignoreNull: false });
    Pipeline.define('updatedAt', () => new Date(), { ignoreNull: false });
    Pipeline.define('toTitleCase', ({ value }) => value.replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()));
    Pipeline.define('toSentenceCase', ({ value }) => value.charAt(0).toUpperCase() + value.slice(1));
    Pipeline.define('timestamp', () => Date.now(), { ignoreNull: false });
    Pipeline.define('dedupe', ({ value }) => uniqWith(value, (b, c) => hashObject(b) === hashObject(c)), { itemize: false });

    // Structures
    Pipeline.define('$instruct', params => Pipeline.resolve(params, 'instruct'), { ignoreNull: false });
    Pipeline.define('$normalize', params => Pipeline.resolve(params, 'normalize'), { ignoreNull: false });
    Pipeline.define('$construct', params => Pipeline.resolve(params, 'construct'), { ignoreNull: false });
    Pipeline.define('$restruct', params => Pipeline.resolve(params, 'restruct'), { ignoreNull: false });
    Pipeline.define('$serialize', params => Pipeline.resolve(params, 'serialize'), { ignoreNull: false });
    Pipeline.define('$deserialize', params => Pipeline.resolve(params, 'deserialize'), { ignoreNull: false });
    Pipeline.define('$validate', params => Pipeline.resolve(params, 'validate'), { ignoreNull: false });

    //
    Pipeline.define('$pk', (params) => {
      const { pkField } = params.model;
      const v = get(params.query.doc, params.path) || params.value?.[pkField] || params.value; // I "think" the get() is for embedded documents
      if (v == null) return params.field.generator({ ...params, value: v });
      return Util.map(v, value => params.field.generator({ ...params, value }));
    }, { ignoreNull: false });

    Pipeline.define('$fk', (params) => {
      const { fkField, linkTo, isPrimaryKey, generator } = params.field;
      const lookupField = isPrimaryKey ? params.field : fkField;
      const v = params.value?.[lookupField] || params.value;
      // const $generator = isPrimaryKey ? generator : linkTo.fields[fkField].generator;
      const $generator = linkTo?.fields?.[fkField]?.generator || generator; // ???
      return Util.map(v, value => $generator({ ...params, value }));
    });

    //
    Pipeline.define('$cast', (params) => {
      const { field, value } = params;

      if (field.isEmbedded) return value;

      switch (field.type.toLowerCase()) {
        case 'string': {
          return `${value}`;
        }
        case 'float': case 'number': {
          const num = Number(value);
          if (!Number.isNaN(num)) return num;
          return value;
        }
        case 'int': {
          const num = Number(value);
          if (!Number.isNaN(num)) return parseInt(value, 10);
          return value;
        }
        case 'boolean': {
          if (value === 'true') return true;
          if (value === 'false') return false;
          return value;
        }
        default: {
          return value;
        }
      }
    });

    //
    Pipeline.define('ensureFK', ({ query, resolver, field, value }) => {
      const { type, fkField } = field;
      const ids = Util.filterBy(Util.ensureArray(value), (a, b) => `${a}` === `${b}`);
      if (!ids.length) return undefined;
      return resolver.match(type).flags(query.flags).where({ [fkField]: ids }).count().then((count) => {
        if (count !== ids.length) {
          throw Boom.notFound(`${type} Not Found`);
        }
      });
    }, { itemize: false });

    // Required fields
    Pipeline.define('required', ({ query, model, field, value, path }) => {
      if ((query.crud === 'create' && value == null) || (query.crud === 'update' && value === null)) {
        throw Boom.badRequest(`${model.name}.${field.name} is required`);
      }
    }, { ignoreNull: false });

    // A field cannot hold a reference to itself
    Pipeline.define('selfless', ({ query, model, field, value }) => {
      if (`${value}` === `${query.doc?.id}`) throw Boom.badRequest(`${model}.${field} cannot hold a reference to itself`);
    });

    // Once set it cannot be changed
    Pipeline.define('immutable', ({ query, model, field, value, path }) => {
      const oldVal = get(query.doc, path);
      if (oldVal !== undefined && value !== undefined && `${hashObject(oldVal)}` !== `${hashObject(value)}`) throw Boom.badRequest(`${model}.${field} is immutable; cannot be changed once set ${oldVal} -> ${value}`);
    });

    // List of allowed values
    Pipeline.factory('Allow', (...args) => function allow({ model, field, value }) {
      if (args.indexOf(value) === -1) throw Boom.badRequest(`${model}.${field} allows ${args}; found '${value}'`);
    });

    // List of disallowed values
    Pipeline.factory('Deny', (...args) => function deny({ model, field, value }) {
      if (args.indexOf(value) > -1) throw Boom.badRequest(`${model}.${field} denys ${args}; found '${value}'`);
    });

    // Min/Max range
    Pipeline.factory('Range', (min, max) => {
      if (min == null) min = undefined;
      if (max == null) max = undefined;

      return function range({ model, field, value }) {
        const num = +value; // Coerce to number if possible
        const test = Number.isNaN(num) ? value.length : num;
        if (test < min || test > max) throw Boom.badRequest(`${model}.${field} must satisfy range ${min}:${max}; found '${value}'`);
      };
    }, { itemize: false });
  }

  static resolve(params, pipeline) {
    const transformers = params.field.pipelines[pipeline] || [];

    return transformers.reduce((value, t) => {
      return Util.uvl(Pipeline[t]({ ...params, value }), value);
    }, params.value);
  }
};

module.exports.createPresets();
