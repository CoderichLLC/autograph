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
    const { ignoreNull = true, itemize = true, configurable = false, docSafe = false, argsSafe = false } = { ...factory.options, ...options };

    const wrapper = Object.defineProperty((args) => {
      try {
        if (ignoreNull && args.value == null) return args.value;
        if (ignoreNull && itemize) {
          if (argsSafe && Array.isArray(args.value)) {
            // Mutate-call-restore: safe because argsSafe factories never retain the bag. The
            // try/finally guarantees args.value is restored to the original array even on throw,
            // so the outer catch's Boom `data` payload stays byte-identical to the Util.map path.
            const items = args.value;
            try {
              return items.map((v) => { args.value = v; return Util.uvl(factory(args), v); });
            } finally {
              args.value = items;
            }
          }
          return Util.map(args.value, value => Util.uvl(factory({ ...args, value }), value));
        }
        return Util.uvl(factory(args), args.value);
      } catch (e) {
        const { data = {} } = e;
        throw Boom.boomify(e, { data: { ...args, ...data } });
      }
    }, 'name', { value: name });

    // INTERNAL metadata (undocumented): docSafe declares the function never reads
    // query.doc/query.merged — consumed by SchemaParser's updateDocFree computation.
    // Custom pipelines default false (conservative): the framework cannot prove a user
    // function's doc-independence. A public opt-in is a deferred follow-up.
    if (docSafe) Object.defineProperty(wrapper, 'docSafe', { value: true });

    // INTERNAL metadata (undocumented): argsSafe declares the function reads everything it needs
    // from the args bag SYNCHRONOUSLY (never retaining the object past its own synchronous body).
    // It lets callers (Pipeline.resolve, the itemize path, Transformer#applyKey) reuse ONE args
    // object across steps/items instead of spreading a fresh one each time. Correctness NEVER
    // depends on this tag — a missing tag costs an allocation, never behavior. Custom pipelines
    // default false (the framework cannot prove a user function's synchronous-read discipline).
    if (argsSafe) Object.defineProperty(wrapper, 'argsSafe', { value: true });

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
    // docSafe: Allow/Deny/Range validators read only `value` (never query.doc/query.merged). Stamp
    // the produced fn AND thread docSafe through `.options` so a subsequent Pipeline.define (e.g.
    // the per-enum Allow the parser installs) carries the flag onto its wrapper (entrySafe reads it).
    // argsSafe: Allow/Deny/Range read only model/field/value synchronously — they never retain the
    // args bag — so the produced fn AND the threaded `.options` both carry argsSafe (a subsequent
    // Pipeline.define, e.g. the per-enum Allow the parser installs, stamps its wrapper from it).
    return Object.defineProperty(Pipeline, name, {
      value: (...args) => {
        const fn = Object.defineProperty(thunk(...args), 'docSafe', { value: true });
        Object.defineProperty(fn, 'argsSafe', { value: true });
        return Object.defineProperty(fn, 'options', { value: { ...options, docSafe: true, argsSafe: true } });
      },
    })[name];
  }

  static createPresets() {
    // Every preset is docSafe unless it reads query.doc (immutable, selfless). $pk IS docSafe:
    // its doc-consumption is exclusive to embedded-array-element paths, and models with
    // embedded fields are categorically excluded from elision (see updateDocFree).
    // argsSafe audit: EVERY preset destructures the params it needs directly in its signature and
    // reads them synchronously — none retains the args object past its own synchronous body.
    //   - The $-structure presets ($cast/$normalize/$construct/.../$validate) delegate to
    //     Pipeline.resolve(params, ...) which itself only reads params synchronously to build the
    //     reduce seed; the reduce's own bag reuse is internal to that call.
    //   - $pk/$fk read params.value/model/field/query.id synchronously; any generator Promise they
    //     return closes over the freshly-spread `{ ...params, value }`, never the shared bag.
    //   - ensureFK returns a resolver.match(...).count().then(...) Promise, but that Promise closes
    //     over the DESTRUCTURED locals (type/fkField/ids) captured synchronously at call time — it
    //     never reads the args object again, so the shared bag can be safely mutated afterward.
    //   - dedupe reads only `value` (itemize:false) synchronously.
    // Hence definePreset threads argsSafe:true for all of them.
    const definePreset = (name, fn, opts = {}) => Pipeline.define(name, fn, { docSafe: true, argsSafe: true, ...opts });

    // Built-In Javascript String Transformers
    const jsStringTransformers = ['toLowerCase', 'toUpperCase', 'toString', 'trim', 'trimEnd', 'trimStart'];
    jsStringTransformers.forEach(name => definePreset(`${name}`, ({ value }) => String(value)[name]()));

    // Additional Transformers
    definePreset('toArray', ({ value }) => (Array.isArray(value) ? value : [value]), { itemize: false });
    definePreset('toDate', ({ value }) => new Date(value), { configurable: true });
    definePreset('createdAt', ({ query, model, value }) => value || (query.crud === 'create' || model.isEmbedded ? new Date() : undefined), { ignoreNull: false });
    definePreset('updatedAt', () => new Date(), { ignoreNull: false });
    definePreset('toTitleCase', ({ value }) => value.replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()));
    definePreset('toSentenceCase', ({ value }) => value.charAt(0).toUpperCase() + value.slice(1));
    definePreset('timestamp', () => Date.now(), { ignoreNull: false });
    definePreset('dedupe', ({ value }) => uniqWith(value, (b, c) => hashObject(b) === hashObject(c)), { itemize: false });

    // Structures
    definePreset('$instruct', params => Pipeline.resolve(params, 'instruct'), { ignoreNull: false });
    definePreset('$normalize', params => Pipeline.resolve(params, 'normalize'), { ignoreNull: false });
    definePreset('$construct', params => Pipeline.resolve(params, 'construct'), { ignoreNull: false });
    definePreset('$restruct', params => Pipeline.resolve(params, 'restruct'), { ignoreNull: false });
    definePreset('$serialize', params => Pipeline.resolve(params, 'serialize'), { ignoreNull: false });
    definePreset('$deserialize', params => Pipeline.resolve(params, 'deserialize'), { ignoreNull: false });
    definePreset('$validate', params => Pipeline.resolve(params, 'validate'), { ignoreNull: false });

    //
    definePreset('$pk', (params) => {
      const { pkField } = params.model;
      const docValue = get(params.query.doc, params.path);
      const isArrayElement = params.path.some(p => typeof p === 'number');
      // Top-level pk: prefer an inline id in the input, otherwise the id supplied via .id() (query.id).
      // Array-element pk: only consider value-supplied ids — query.id is the parent doc's id, not the element's.
      // Three cases:
      //   (1) Top-level + single embedded: doc-first preserves ids on partial updates and avoids id churn.
      //   (2) Array element where the user explicitly supplied an id (startValue is truthy):
      //       user wins — they're targeting that specific element.
      //   (3) Array element with no user-supplied id (startValue is undefined): positional fallback
      //       to doc preserves array-element ids so downstream smart-merge logic can locate the
      //       intended doc element to merge into.
      const userValue = isArrayElement
        ? (params.value?.[pkField] || params.value)
        : (params.value?.[pkField] || params.value || params.query.id);
      const userExplicit = isArrayElement && params.startValue !== undefined;
      const v = userExplicit ? (userValue || docValue) : (docValue || userValue);
      if (v == null) return params.field.generator({ ...params, value: v });
      return Util.map(v, value => params.field.generator({ ...params, value }));
    }, { ignoreNull: false });

    definePreset('$fk', (params) => {
      const { fkField, linkTo, isPrimaryKey, generator } = params.field;
      const lookupField = isPrimaryKey ? params.field : fkField;
      const v = params.value?.[lookupField] || params.value;
      // const $generator = isPrimaryKey ? generator : linkTo.fields[fkField].generator;
      const $generator = linkTo?.fields?.[fkField]?.generator || generator; // ???
      return Util.map(v, value => $generator({ ...params, value }));
    });

    //
    definePreset('$cast', (params) => {
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
    definePreset('ensureFK', ({ query, resolver, field, value }) => {
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
    definePreset('required', ({ query, model, field, value, path }) => {
      if ((query.crud === 'create' && value == null) || (query.crud === 'update' && value === null)) {
        throw Boom.badRequest(`${model.name}.${field.name} is required`);
      }
    }, { ignoreNull: false });

    // A field cannot hold a reference to itself.
    // NOT docSafe (direct Pipeline.define, no definePreset): reads query.doc.id — a field carrying
    // this needs the pre-image, so it blocks updateDocFree elision.
    // argsSafe (reads query.doc.id synchronously; NOT docSafe — it needs the pre-image).
    Pipeline.define('selfless', ({ query, model, field, value }) => {
      if (`${value}` === `${query.doc?.id}`) throw Boom.badRequest(`${model}.${field} cannot hold a reference to itself`);
    }, { argsSafe: true });

    // Once set it cannot be changed.
    // NOT docSafe (direct Pipeline.define, no definePreset): reads the prior value from query.doc
    // via get(query.doc, path) — a field carrying this needs the pre-image, so it blocks elision.
    // argsSafe (reads query.doc via get(...) synchronously; NOT docSafe — it needs the pre-image).
    Pipeline.define('immutable', ({ query, model, field, value, path }) => {
      const oldVal = get(query.doc, path);
      if (oldVal !== undefined && value !== undefined && `${hashObject(oldVal)}` !== `${hashObject(value)}`) throw Boom.badRequest(`${model}.${field} is immutable; cannot be changed once set ${oldVal} -> ${value}`);
    }, { argsSafe: true });

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
    let bag; // ONE reusable args object for argsSafe steps — allocated lazily, .value mutated per step

    return transformers.reduce((value, t) => {
      const fn = Pipeline[t];
      if (fn.argsSafe) {
        bag ??= { ...params };
        bag.value = value;
        return Util.uvl(fn(bag), value);
      }
      return Util.uvl(fn({ ...params, value }), value);
    }, params.value);
  }
};

module.exports.createPresets();
