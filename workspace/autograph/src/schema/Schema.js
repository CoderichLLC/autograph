/* eslint-disable indent */

const Util = require('@coderich/util');
const { Kind, parse, visit } = require('graphql');
const { mergeTypeDefs, mergeFields, mergeDirectives } = require('@graphql-tools/merge');
const { isLeafValue, mergeDeep, fromGUID } = require('../service/AppService');
const Transformer = require('../data/Transformer');
const Pipeline = require('../data/Pipeline');
const Emitter = require('../data/Emitter');

const operations = ['Query', 'Mutation', 'Subscription'];
const interfaceKinds = [Kind.INTERFACE_TYPE_DEFINITION, Kind.INTERFACE_TYPE_EXTENSION];
// const unionKinds = [Kind.UNION_TYPE_DEFINITION, Kind.UNION_TYPE_EXTENSION];
const enumKinds = [Kind.ENUM_TYPE_DEFINITION, Kind.ENUM_TYPE_EXTENSION];
const scalarKinds = [Kind.SCALAR_TYPE_DEFINITION, Kind.SCALAR_TYPE_EXTENSION];
const fieldKinds = [Kind.FIELD_DEFINITION];
const modelKinds = [Kind.OBJECT_TYPE_DEFINITION, Kind.OBJECT_TYPE_EXTENSION].concat(interfaceKinds);
const allowedKinds = modelKinds.concat(fieldKinds).concat(Kind.DOCUMENT, Kind.NON_NULL_TYPE, Kind.NAMED_TYPE, Kind.LIST_TYPE, Kind.DIRECTIVE).concat(scalarKinds).concat(enumKinds);
const pipelines = ['validate', 'construct', 'restruct', 'instruct', 'normalize', 'serialize'];
const createPipelines = ['validate', 'construct', 'instruct', 'normalize', 'serialize'];
const updatePipelines = ['validate', 'restruct', 'instruct', 'normalize', 'serialize'];
// const validatePipelines = ['validate', 'instruct', 'normalize', 'serialize'];
const scalars = ['ID', 'String', 'Float', 'Int', 'Boolean'];

module.exports = class Schema {
  #config;
  #schema;
  #typeDefs;
  #resolvers = {};

  constructor(config) {
    this.#config = config;
    this.#config.namespace ??= 'autograph';
    this.#config.directives ??= {};
    this.#config.directives.model ??= 'model';
    this.#config.directives.field ??= 'field';
    this.#config.directives.link ??= 'link';
    this.#config.directives.index ??= 'index';
    this.#typeDefs = Schema.#framework(this.#config.directives);
  }

  /* ****** DEPRECATE! ****** */
  getModels() {
    return this.#schema.models;
  }

  getModel(name) {
    return this.#schema.models[`${name}`];
  }
  /* ***************** */

  /**
   * Decorate each marked @model with config-driven field decorators
   */
  decorate() {
    const { directives: { model } } = this.#config;

    this.#typeDefs = visit(this.#typeDefs, {
      enter: (node) => {
        if (modelKinds.includes(node.kind) && !operations.includes(node.name.value)) {
          const directive = node.directives.find(({ name }) => name.value === model);

          if (directive) {
            const arg = directive.arguments.find(({ name }) => name.value === 'decorate');
            const value = Util.uvl(Schema.#resolveNodeValue(arg?.value), 'default');
            const decorator = this.#config.decorators?.[value];

            if (decorator) {
              const { fields, directives } = parse(decorator).definitions[0];
              node.fields = mergeFields(node, node.fields, fields, { noLocation: true, onFieldTypeConflict: (f, a, b) => a });
              const modelDirective = directives.find(({ name }) => name.value === model);
              if (modelDirective) Object.assign(directive, mergeDirectives([directive], [modelDirective], { noLocation: true, onFieldTypeConflict: (f, a, b) => a })[0]);
              return node;
            }
          }

          return false; // Do not traverse any deeper
        }

        return undefined; // Continue traversal
      },
    });

    return this;
  }

  /**
   * Merge typeDefs and resolvers
   */
  merge(schema = {}) {
    // Normalize schema input
    if (typeof schema === 'string') schema = { typeDefs: schema };
    else if (schema instanceof Schema) schema = schema.toObject();

    if (schema.typeDefs) {
      const typeDefs = Util.ensureArray(schema.typeDefs).map((td) => {
        try {
          const $td = typeof td === 'string' ? parse(td) : td;
          return $td;
        } catch {
          console.log(`Unable to parse typeDef (being ignored):\n${td}`); // eslint-disable-line
          return null;
        }
      }).filter(Boolean);

      this.#typeDefs = mergeTypeDefs([typeDefs, this.#typeDefs], { noLocation: true, reverseDirectives: true, onFieldTypeConflict: a => a });
    }

    if (schema.resolvers) {
      this.#resolvers = mergeDeep(schema.resolvers, this.#resolvers);
    }

    return this;
  }

  /**
   * Parse typeDefs; returning a schema POJO
   */
  parse() {
    if (this.#schema) return this.#schema;

    const { directives, namespace } = this.#config;
    this.#schema = { models: {}, enums: {}, scalars: {}, indexes: [], namespace };
    let target, model, field, isList;
    const thunks = [];

    // Deprecate
    this.#schema.getModel = name => this.#schema.models[`${name}`];

    // Parse AST (build/defined this.#schema)
    visit(this.#typeDefs, {
      enter: (node) => {
        const name = node.name?.value;

        if (!allowedKinds.includes(node.kind) || operations.includes(name)) return false;

        if (modelKinds.includes(node.kind)) {
          target = model = this.#schema.models[name] = {
            name,
            key: name,
            fields: {},
            crud: 'crud', // For use when creating API Queries and Mutations
            scope: 'crud', // For use when defining types (how it's field.model reference can be used)
            pkField: 'id',
            isEmbedded: true,
            isPersistable: true,
            source: this.#config.dataSources?.default,
            loader: this.#config.dataLoaders?.default,
            generator: this.#config.generators?.default,
            pipelines: pipelines.reduce((prev, key) => Object.assign(prev, { [key]: [] }), {}),
            transformers: {
              validate: new Transformer({ args: { schema: this.#schema, path: [] } }),
              create: new Transformer({ args: { schema: this.#schema, path: [] } }),
              update: new Transformer({ args: { schema: this.#schema, path: [] } }),
              where: new Transformer({ args: { schema: this.#schema, path: [] } }),
            },
            directives: {},
            ignorePaths: [],
            referentialIntegrity: [],
            toString: () => name,
          };
        }

        if (fieldKinds.includes(node.kind)) {
          target = field = model.fields[name] = {
            name,
            key: name,
            pipelines: pipelines.reduce((prev, key) => Object.assign(prev, { [key]: [] }), {}),
            directives: {},
            toString: () => name,
          };
        }

        if (scalarKinds.includes(node.kind)) {
          scalars.push(name);
          target = this.#schema.scalars[name] = {
            directives: {},
            pipelines: pipelines.reduce((prev, key) => Object.assign(prev, { [key]: [] }), {}),
          };
        }

        if (enumKinds.includes(node.kind)) {
          const values = Schema.#resolveNodeValue(node);

          target = this.#schema.enums[name] = {
            values,
            directives: {},
            pipelines: pipelines.reduce((prev, key) => Object.assign(prev, { [key]: [] }), {}),
          };

          // Define (and assign) an Allow pipeline for the enumeration
          Pipeline.define(name, Pipeline.Allow(...values), { configurable: true });
          target.pipelines.validate.push(name);
        }

        if (node.kind === Kind.NON_NULL_TYPE) {
          target[isList ? 'isArrayRequired' : 'isRequired'] = true;
        } else if (node.kind === Kind.NAMED_TYPE) {
          target.type = target.linkTo = node.name.value;
        } else if (node.kind === Kind.LIST_TYPE) {
          target.isArray = true;
          isList = true;
        } else if (node.kind === Kind.DIRECTIVE) {
          target.directives[name] = target.directives[name] || {};

          if (name === directives.model) {
            model.isEntity = true;
            model.isMarkedModel = true;
            model.isEmbedded = false;
          } else if (name === directives.index) {
            this.#schema.indexes.push({ model });
          }

          node.arguments.forEach((arg) => {
            const key = arg.name.value;
            const value = Schema.#resolveNodeValue(arg.value);
            target.directives[name][key] = value;

            if (name === directives.index) this.#schema.indexes[this.#schema.indexes.length - 1][key] = value;

            switch (`${name}-${key}`) {
              // Model specific directives
              case `${directives.model}-pk`: {
                model.pkField = value;
                break;
              }
              case `${directives.model}-source`: {
                model.source = this.#config.dataSources?.[value];
                break;
              }
              case `${directives.model}-loader`: {
                model.loader = this.#config.dataLoaders?.[value];
                break;
              }
              case `${directives.model}-embed`: {
                model.isEmbedded = value;
                model.isEntity = !value;
                break;
              }
              // Field specific directives
              case `${directives.field}-fk`: {
                target.fkField = value;
                break;
              }
              case `${directives.field}-default`: {
                target.defaultValue = value;
                break;
              }
              case `${directives.field}-connection`: {
                target.isConnection = value;
                break;
              }
              case `${directives.field}-validate`: {
                target.pipelines.validate = target.pipelines.validate.concat(value).filter(Boolean);
                break;
              }
              case `${directives.field}-transform`: { // Deprecated
                target.pipelines.normalize = target.pipelines.normalize.concat(value).filter(Boolean);
                break;
              }
              case `${directives.link}-to`: {
                target.linkTo = value;
                target.isVirtual ??= true;
                break;
              }
              case `${directives.link}-by`: {
                target.linkBy = value;
                target.isVirtual ??= true;
                break;
              }
              // Generic by target directives
              case `${directives.model}-id`: case `${directives.field}-id`: {
                target.generator = this.#config.generators[value];
                break;
              }
              case `${directives.model}-persist`: case `${directives.field}-persist`: {
                target.isPersistable = value;
                break;
              }
              case `${directives.model}-crud`: case `${directives.model}-scope`: case `${directives.field}-crud`: {
                target[key] = Util.nvl(value, '');
                break;
              }
              case `${directives.model}-key`:
              case `${directives.model}-meta`:
              case `${directives.field}-key`:
              case `${directives.field}-onDelete`: {
                target[key] = value;
                break;
              }

              // Backwards compat (deprecated)
              case 'model-gqlScope': { model.crud = value; break; }
              case 'model-fieldScope': { model.scope = value; break; }
              case 'field-gqlScope': { target.crud = value; break; }

              // Pipelines
              default: {
                if (pipelines.includes(key)) {
                  target.pipelines[key] = target.pipelines[key].concat(value).filter(Boolean);
                }
                break;
              }
            }
          });
        }

        return undefined; // Continue
      },
      leave: (node) => {
        if (modelKinds.includes(node.kind)) {
          const $model = model;

          // Model resolution after field resolution (push)
          thunks.push(($schema) => {
            $model.resolvePath = (path, prop = 'name') => this.#schema.resolvePath(`${$model[prop]}.${path}`, prop);

            $model.isJoinPath = (path, prop = 'name') => {
              let foundJoin = false;
              return !path.split('.').every((el, i, arr) => {
                if (foundJoin) return false;
                const $field = $model.resolvePath(arr.slice(0, i + 1).join('.'), prop);
                foundJoin = $field.isVirtual || $field.isFKReference;
                return !$field.isVirtual;
              });
            };

            $model.walk = (data, fn, opts = {}) => {
              if (data == null || !Util.isPlainObject(data)) return data;

              // Options
              opts.key = opts.key ?? 'name';
              opts.run = opts.run ?? [];
              opts.path = opts.path ?? [];
              opts.itemize = opts.itemize ?? true;

              return Object.entries(data).reduce((prev, [key, value]) => {
                // Find the field; remove it if not found
                const $field = Object.values($model.fields).find(el => el[opts.key] === key);
                if (!$field) return prev;

                // Invoke callback function; allowing result to be modified in order to change key/value
                let run = opts.run.concat($field[opts.key]);
                const path = opts.path.concat($field[opts.key]);
                const isLeaf = isLeafValue(value);
                const $node = fn({ model: $model, field: $field, key, value, path, run, isLeaf });
                if (!$node) return prev;

                // Recursive walk
                if (!$field.model?.isEmbedded) run = [];
                const $value = opts.itemize && $field.model && Util.isPlainObjectOrArray($node.value) ? Util.map($node.value, el => $field.model.walk(el, fn, { ...opts, path, run })) : $node.value;
                return Object.assign(prev, { [$node.key]: $value });
              }, {});
            };

            $model.transformers.toDriver = new Transformer({
              shape: Object.values($model.fields).reduce((prev, curr) => {
                const rules = [curr.key]; // Rename key
                if (curr.isEmbedded) rules.unshift(({ value }) => Util.map(value, v => curr.model.transformers.toDriver.transform(v)));
                return Object.assign(prev, { [curr.name]: rules });
              }, {}),
            });

            $model.transformers.create.config({
              strictSchema: true,
              keepUndefined: true,
              shape: Object.values($model.fields).reduce((prev, curr) => {
                const args = { model: $model, field: curr };

                const rules = [
                  a => Pipeline.$cast({ ...a, ...args, path: a.path.concat(curr.name) }),
                  a => Pipeline.$normalize({ ...a, ...args, path: a.path.concat(curr.name) }),
                  a => Pipeline.$instruct({ ...a, ...args, path: a.path.concat(curr.name) }),
                  a => Pipeline.$construct({ ...a, ...args, path: a.path.concat(curr.name) }),
                  a => Pipeline.$serialize({ ...a, ...args, path: a.path.concat(curr.name) }),
                ];

                if (curr.isEmbedded) {
                  rules.push(a => Util.map(a.value, (value, i) => {
                    const path = a.path.concat(curr.name);
                    if (curr.isArray) path.push(i);
                    return curr.model.transformers.create.transform(value, { ...args, thunks: a.thunks, query: a.query, resolver: a.resolver, context: a.context, path });
                  }));
                }

                return Object.assign(prev, { [curr.name]: rules });
              }, {}),
              defaults: Object.values($model.fields).reduce((prev, curr) => {
                if (curr.defaultValue !== undefined) return Object.assign(prev, { [curr.name]: curr.defaultValue });
                if (createPipelines.some(el => curr.pipelines[el].length)) return Object.assign(prev, { [curr.name]: undefined });
                return prev;
              }, {}),
            });

            $model.transformers.update.config({
              strictSchema: true,
              keepUndefined: true,
              shape: Object.values($model.fields).reduce((prev, curr) => {
                const args = { model: $model, field: curr };

                const rules = [
                  a => Pipeline.$cast({ ...a, ...args, path: a.path.concat(curr.name) }),
                  a => Pipeline.$normalize({ ...a, ...args, path: a.path.concat(curr.name) }),
                  a => Pipeline.$instruct({ ...a, ...args, path: a.path.concat(curr.name) }),
                  a => Pipeline.$restruct({ ...a, ...args, path: a.path.concat(curr.name) }),
                  a => Pipeline.$serialize({ ...a, ...args, path: a.path.concat(curr.name) }),
                ];

                if (curr.isEmbedded) {
                  rules.push(a => Util.map(a.value, (value, i) => {
                    const path = a.path.concat(curr.name);
                    if (curr.isArray) path.push(i);
                    return curr.model.transformers.update.transform(value, { ...args, thunks: a.thunks, query: a.query, resolver: a.resolver, context: a.context, path });
                  }));
                }

                return Object.assign(prev, { [curr.name]: rules });
              }, {}),
              defaults: Object.values($model.fields).reduce((prev, curr) => {
                if (updatePipelines.some(el => curr.pipelines[el].length)) return Object.assign(prev, { [curr.name]: undefined });
                return prev;
              }, {}),
            });

            $model.transformers.where.config({
              keepUndefined: true,
              shape: Object.values($model.fields).reduce((prev, curr) => {
                const args = { model: $model, field: curr };

                const rules = [
                  a => Pipeline.$cast({ ...a, ...args, path: a.path.concat(curr.name) }),
                  a => Pipeline.$instruct({ ...a, ...args, path: a.path.concat(curr.name) }),
                  a => Pipeline.$serialize({ ...a, ...args, path: a.path.concat(curr.name) }),
                ];

                if (curr.isEmbedded) {
                  rules.push(a => Util.map(a.value, (value, i) => {
                    const path = a.path.concat(curr.name);
                    if (curr.isArray) path.push(i);
                    return curr.model.transformers.where.transform(value, { ...args, query: a.query, context: a.context, path });
                  }));
                }

                return Object.assign(prev, { [curr.name]: rules });
              }, {}),
              defaults: Object.values($model.fields).reduce((prev, curr) => {
                if (curr.pipelines.instruct.length) return Object.assign(prev, { [curr.name]: undefined });
                return prev;
              }, {}),
            });

            $model.transformers.sort = $model.transformers.where.clone({ defaults: {} });

            $model.transformers.validate.config({
              strictSchema: true,
              shape: Object.values($model.fields).reduce((prev, curr) => {
                const args = { model: $model, field: curr };
                const rules = [];

                if (curr.isEmbedded) {
                  rules.push(a => Util.map(a.value, (value, i) => {
                    const path = a.path.concat(curr.name);
                    if (curr.isArray) path.push(i);
                    return curr.model.transformers.validate.transform(value, { ...args, thunks: a.thunks, query: a.query, resolver: a.resolver, context: a.context, path });
                  }));
                }

                rules.push(a => Pipeline.$validate({ ...a, ...args, path: a.path.concat(curr.name) }));

                return Object.assign(prev, { [curr.name]: rules });
              }, {}),
            });

            // Deserialize/docs special case handling for performance
            const docFields = Object.values($model.fields);
            $model.docTransform = (doc) => {
              if (doc == null) return doc;
              const out = {};
              for (const docField of docFields) {
                let value = docField.key in doc ? doc[docField.key] : docField.defaultValue;
                if (value === undefined) continue; // eslint-disable-line
                if (docField.isArray) value = value == null ? value : Util.ensureArray(value);
                if (docField.isEmbedded) value = Util.map(value, v => docField.model.docTransform(v));
                out[docField.name] = value;
              }
              return out;
            };

            Util.traverse(Object.values($model.fields), (f, info) => {
              const path = info.path.concat(f.name);
              if (f.isEmbedded) return { value: Object.values(f.model.fields), info: { path } };
              if (f.isScalar) $model.ignorePaths.push(path.join('.'));
              return null;
            }, { path: [] });
          });
        } else if (node.kind === Kind.FIELD_DEFINITION) {
          const $field = field;
          const $model = model;

          field.isPrimaryKey = Boolean(field.name === model.pkField);
          field.isPersistable = Util.uvl(field.isPersistable, model.isPersistable, true);

          // Field resolution comes first (unshift)
          thunks.unshift(($schema) => {
            $field.model = $schema.models[$field.type];
            $field.linkTo = $schema.models[$field.linkTo];
            $field.crud = Util.uvl($field.crud, $field.model?.scope, 'crud');
            $field.linkBy ??= $field.linkTo?.pkField; // This defines join logic (below) for both straight+virtual references
            $field.fkField ??= $field.linkTo?.pkField; // This is the fkReference field for straight references
            // $field.fkField ??= $field.model?.pkField; // This is the fkReference field for straight references
            $field.linkField = $field.isVirtual ? $model.fields[$model.pkField] : $field;
            $field.isFKReference = $field.fkField && !$field.isPrimaryKey && $field.model?.isMarkedModel && !$field.model?.isEmbedded;
            $field.isEmbedded = Boolean($field.model && !$field.isFKReference && !$field.isPrimaryKey);
            $field.isScalar = scalars.includes($field.type);
            $field.generator ??= $model.generator;

            // Referential Integrity Setup
            if ($field.onDelete) $field.model.referentialIntegrity.push(...this.#findModelPathsToField($model, $field));

            // Merge Enums and Scalar type definitions
            const enumer = this.#schema.enums[$field.type];
            const scalar = this.#schema.scalars[$field.type];
            if (enumer) {
              $field.allows = enumer.values;
              Object.entries(enumer.pipelines).forEach(([key, values]) => $field.pipelines[key].push(...values));
            }
            if (scalar) Object.entries(scalar.pipelines).forEach(([key, values]) => $field.pipelines[key].push(...values));

            if ($field.isArray) $field.pipelines.normalize.unshift('toArray');

            // Will create/convert to ID type always
            if ($field.isPrimaryKey) {
              $field.pipelines.construct.unshift('$pk');
              $field.pipelines.restruct.unshift('$pk');
            }

            // Will convert to ID type IFF defined in payload
            if ($field.isFKReference || $field.isPrimaryKey) $field.pipelines.serialize.unshift('$fk');

            if ($field.isRequired && $field.isPersistable && !$field.isVirtual) $field.pipelines.validate.push('required');

            if ($field.isFKReference) {
              const to = $field.model.key;
              const on = $field.linkTo.fields[$field.linkBy].key;
              const from = $field.linkField.key;
              const as = `join_${to}`;
              $field.join = { to, on, from, as };
              $field.pipelines.validate.push('ensureFK'); // Absolute Last
            }
          });

          target = model;
        } else if (node.kind === Kind.LIST_TYPE) {
          isList = false;
        } else if (scalarKinds.concat(enumKinds).includes(node.kind)) {
          target = model;
        }
      },
    });

    // Resolve data thunks
    thunks.forEach(thunk => thunk(this.#schema));

    // Resolve indexes
    this.#schema.indexes = this.#schema.indexes.map((index) => {
      const { key } = index.model;
      const { name, type } = index;
      const on = index.on.map(f => index.model.fields[f].key);
      return { key, name, type, on };
    });

    // Helper methods
    const resolvePathCache = {};
    this.#schema.resolvePath = (path, prop = 'key') => {
      resolvePathCache[path] ??= (() => {
        const [modelKey, ...fieldKeys] = path.split('.');
        const $model = Object.values(this.#schema.models).find(el => el[prop] === modelKey);
        if (!$model || !fieldKeys.length) return $model;
        return fieldKeys.reduce((parent, key) => Object.values(parent.fields || parent.model?.fields || {}).find(el => el[prop] === key) || parent, $model);
      })();
      return resolvePathCache[path];
    };

    // Mutate typeDefs
    let $model;
    this.#typeDefs = visit(this.#typeDefs, {
      enter: (node) => {
        const name = node.name?.value;
        if (!allowedKinds.includes(node.kind) || operations.includes(name)) return false;

        if (modelKinds.includes(node.kind)) {
          $model = this.#schema.models[name];
        } else if (fieldKinds.includes(node.kind)) {
          if (!Util.uvl($model?.fields[name]?.crud, 'crud')?.includes('r')) return null;
        }

        return undefined;
      },
    });

    // Return schema
    return this.#schema;
  }

  api() {
    return this.merge(Schema.#api(this.parse()));
  }

  framework() {
    this.#typeDefs = Schema.#framework(this.#config.directives);
    return this;
  }

  setup() {
    return Emitter.emit('setup', this.#schema);
  }

  toObject() {
    return {
      typeDefs: this.#typeDefs,
      resolvers: this.#resolvers,
    };
  }

  makeExecutableSchema() {
    return this.#config.makeExecutableSchema(this.toObject());
  }

  #findModelPathsToField(model, field) {
    if (!model.isEmbedded) return [{ model, field, path: [`${field}`], isArray: field.isArray }];

    const arr = [];

    Object.values(this.#schema.models).filter(m => m.isEntity).forEach((m) => {
      Util.traverse(Object.values(m.fields), (f, info) => {
        const path = info.path.concat(f.name);
        if (f.type === model.name) arr.push({ model: m, field, path: path.concat(`${field}`), isArray: info.isArray || field.isArray || f.isArray });
        else if (f.isEmbedded) return { value: Object.values(f.model.fields), info: { path, isArray: info.isArray || f.isArray } };
        return null;
      }, { path: [], isArray: false });
    });

    return arr;
  }

  static #resolveNodeValue(node) {
    if (node == null) return node;

    switch (node.kind) {
      case 'NullValue': return null;
      case 'ListValue': return node.values.map(Schema.#resolveNodeValue);
      case 'EnumValueDefinition': return node.name.value;
      case 'EnumTypeDefinition': return node.values.map(Schema.#resolveNodeValue);
      case 'ObjectValue': return node.fields.reduce((prev, field) => Object.assign(prev, { [field.name.value]: Schema.#resolveNodeValue(field.value) }), {});
      default: return node.value ?? node;
    }
  }

  static #framework(directives) {
    const { model, field, link, index } = directives;

    return parse(`
      scalar AutoGraphMixed
      scalar AutoGraphDriver # DELETE WHEN MIGRATED

      enum AutoGraphIndexEnum { unique }
      enum AutoGraphAuthzEnum { private protected public } # DELETE WHEN MIGRATED
      enum AutoGraphOnDeleteEnum { cascade nullify restrict }
      enum AutoGraphPipelineEnum { ${Object.keys(Pipeline).filter(k => !k.startsWith('$')).join(' ')} }

      directive @${model}(
        id: String # Specify the generator strategy (default: "default")
        pk: String # Specify the PK field (default "id")
        key: String # Specify db table/collection name
        crud: AutoGraphMixed # CRUD API
        scope: AutoGraphMixed #
        meta: AutoGraphMixed # Custom input "meta" field for mutations
        source: AutoGraphMixed # Data source (default: "default")
        decorate: AutoGraphMixed # Decorator (default: "default")
        embed: Boolean # Mark this an embedded model (default false)
        persist: Boolean # Persist this model (default true)

        # TEMP TO APPEASE TRANSITION
        driver: AutoGraphDriver # External data driver
        createdAt: String # Specify db key (default "createdAt")
        updatedAt: String # Specify db key (default "updatedAt")
        gqlScope: AutoGraphMixed # Dictate how GraphQL API behaves
        dalScope: AutoGraphMixed # Dictate how the DAL behaves
        fieldScope: AutoGraphMixed # Dictate how a FIELD may use me
        authz: AutoGraphAuthzEnum # Access level used for authorization (default: private)
        namespace: String # Logical grouping of models that can be globbed (useful for authz)
      ) on OBJECT | INTERFACE

      directive @${field}(
        id: String # Specify the generator strategy (default: "default")
        fk: String # Specify the FK field (default model.pk)
        key: String # Specify db key
        persist: Boolean # Persist this field (default true)
        connection: Boolean # Treat this field as a connection type (default false - rolling this out slowly)
        default: AutoGraphMixed # Define a default value
        crud: AutoGraphMixed # CRUD API
        onDelete: AutoGraphOnDeleteEnum # onDelete behavior

        # Pipeline Structure
        normalize: [AutoGraphPipelineEnum!]
        instruct: [AutoGraphPipelineEnum!]
        construct: [AutoGraphPipelineEnum!]
        restruct: [AutoGraphPipelineEnum!]
        serialize: [AutoGraphPipelineEnum!]
        validate: [AutoGraphPipelineEnum!]

        # TEMP TO APPEASE TRANSITION
        ref: AutoGraphMixed # Specify the modelRef field's name (overrides isEmbedded)
        gqlScope: AutoGraphMixed # Dictate how GraphQL API behaves
        dalScope: AutoGraphMixed # Dictate how the DAL behaves
        transform: [AutoGraphPipelineEnum!]
      ) on FIELD_DEFINITION | INPUT_FIELD_DEFINITION | SCALAR

      directive @${link}(
        to: AutoGraphMixed  # The MODEL to link to (default's to modelRef)
        by: AutoGraphMixed! # The FIELD to match yourself by
        use: AutoGraphMixed # The VALUE to use (default's to @link'd value); useful for many-to-many relationships
      ) on FIELD_DEFINITION

      directive @${index}(
        name: String
        on: [AutoGraphMixed!]!
        type: AutoGraphIndexEnum!
      ) repeatable on OBJECT
    `);
  }

  static #api(schema) {
    // These models are for creating types
    const readModels = Object.values(schema.models).filter(model => [model.crud, model.scope].join()?.includes('r'));
    const createModels = Object.values(schema.models).filter(model => [model.crud, model.scope].join()?.includes('c'));
    const updateModels = Object.values(schema.models).filter(model => [model.crud, model.scope].join()?.includes('u'));

    // These are for defining schema queries/mutations
    const entityModels = Object.values(schema.models).filter(model => model.isEntity);
    const queryModels = entityModels.filter(model => model.crud?.includes('r'));
    const mutationModels = entityModels.filter(model => ['c', 'u', 'd'].some(el => model.crud?.includes(el)));
    const subscriptionModels = entityModels.filter(model => model.crud?.includes('s'));

    return {
      typeDefs: `
        scalar AutoGraphMixed
        scalar AutoGraphDateTime

        interface Node { id: ID! }

        enum SortOrderEnum { asc desc }
        enum SubscriptionCrudEnum { create update delete }
        enum SubscriptionWhenEnum { preEvent postEvent }

        type PageInfo {
          startCursor: String!
          endCursor: String!
          hasPreviousPage: Boolean!
          hasNextPage: Boolean!
        }

        ${entityModels.map(model => `
          extend type ${model} implements Node {
            id: ID!
          }
        `)}

        ${readModels.map((model) => {
          const fields = Object.values(model.fields).filter(field => field.crud?.includes('r'));
          const connectionFields = fields.filter(field => field.isConnection);

          return `
            input ${model}InputWhere {
              ${fields.map(field => `${field}: ${field.model ? `${field.model}InputWhere` : 'AutoGraphMixed'}`)}
            }
            input ${model}InputSort {
              ${fields.map(field => `${field}: ${field.model ? `${field.model}InputSort` : 'SortOrderEnum'}`)}
            }
            type ${model}Connection {
              count: Int!
              pageInfo: PageInfo
              edges: [${model}Edge]
            }
            type ${model}Edge {
              node: ${model}
              cursor: String
            }
            ${connectionFields.length ? `
              extend type ${model} {
                ${connectionFields.map(field => `${field}(${Schema.#getConnectionArguments(field.model)}): ${field.model}Connection`)}
              }
            ` : ''}
          `;
        })}

        ${createModels.map((model) => {
          const fields = Object.values(model.fields).filter(field => field.crud?.includes('c') && !field.isVirtual);

          return `
            input ${model}InputCreate {
              ${fields.map(field => `${field}: ${Schema.#getGQLType(field, 'InputCreate')}`)}
            }
          `;
        })}

        ${updateModels.map((model) => {
          const fields = Object.values(model.fields).filter(field => field.crud?.includes('u') && !field.isVirtual);

          return `
            input ${model}InputUpdate {
              ${fields.map(field => `${field}: ${Schema.#getGQLType(field, 'InputUpdate')}`)}
            }
          `;
        })}

        type Query {
          node(id: ID!): Node
          ${queryModels.map(model => `
            get${model}(id: ID!): ${model}
            find${model}(${Schema.#getConnectionArguments(model)}): ${model}Connection!
          `)}
        }

        ${mutationModels.length ? `
          type Mutation {
            ${mutationModels.map((model) => {
              const api = [];
              const meta = model.meta ? `meta: ${model.meta}` : '';
              if (model.crud?.includes('c')) api.push(`create${model}(input: ${model}InputCreate! ${meta}): ${model}!`);
              if (model.crud?.includes('u')) api.push(`update${model}(id: ID! input: ${model}InputUpdate ${meta}): ${model}!`);
              if (model.crud?.includes('d')) api.push(`delete${model}(id: ID! ${meta}): ${model}!`);
              return api.join('\n');
            })}
          }
        ` : ''}

        ${subscriptionModels.length ? `
          type Subscription {
            ${subscriptionModels.map(model => `
              ${model}(
                on: [SubscriptionCrudEnum!]! = [create, update, delete]
                filter: ${model}SubscriptionInputFilter
              ): ${model}SubscriptionPayload!
            `)}
          }

          ${subscriptionModels.map((model) => {
            const fields = Object.values(model.fields).filter(field => field.crud?.includes('r'));

            return `
              input ${model}SubscriptionInputFilter {
                when: [SubscriptionWhenEnum!]! = [preEvent, postEvent]
                where: ${model}SubscriptionInputWhere! = {}
              }

              input ${model}SubscriptionInputWhere {
                ${fields.map(field => `${field}: ${field.model ? `${field.model}InputWhere` : 'AutoGraphMixed'}`)}
              }

              type ${model}SubscriptionPayload {
                event: ${model}SubscriptionPayloadEvent
                query: ${model}SubscriptionQuery
              }

              type ${model}SubscriptionPayloadEvent {
                crud: SubscriptionCrudEnum!
                data: ${model}SubscriptionPayloadEventData!
              }

              type ${model}SubscriptionPayloadEventData {
                ${fields.map(field => `${field}: ${Schema.#getGQLType(field)}`)}
              }

              interface ${model}SubscriptionQuery {
                ${fields.map(field => `${field}: ${Schema.#getGQLType(field)}`)}
              }

              type ${model}Create implements ${model}SubscriptionQuery {
                ${fields.map(field => `${field}: ${Schema.#getGQLType(field)}`)}
              }

              type ${model}Update implements ${model}SubscriptionQuery {
                ${fields.map(field => `${field}: ${Schema.#getGQLType(field)}`)}
              }
            `;
          })}
        ` : ''}
      `,
      resolvers: {
        Node: {
          __resolveType: (doc, args, context, info) => doc.__typename,
        },
        ...queryModels.reduce((prev, model) => {
          return Object.assign(prev, {
            [`${model}Connection`]: {
              count: ({ count }) => count(),
              edges: ({ edges }) => edges().then(rs => rs.map(node => ({ cursor: node.$cursor, node }))),
              pageInfo: ({ pageInfo }) => pageInfo().then(rs => rs?.$pageInfo),
            },
          });
        }, {}),
        Query: queryModels.reduce((prev, model) => {
          return Object.assign(prev, {
            [`get${model}`]: (doc, args, context, info) => context[schema.namespace].resolver.match(model).args(args).info(info).one({ required: true }),
            [`find${model}`]: (doc, args, context, info) => context[schema.namespace].resolver.match(model).args(args).info(info).resolve(info),
          });
        }, {
          node: (doc, args, context, info) => {
            const { id } = args;
            const [modelName] = fromGUID(id);
            const model = schema.models[modelName];
            return context[schema.namespace].resolver.match(model).id(id).info(info).one().then((result) => {
              if (result == null) return result;
              result.__typename = modelName;
              return result;
            });
          },
        }),
        ...(mutationModels.length ? {
          Mutation: mutationModels.reduce((prev, model) => {
            if (model.crud?.includes('c')) prev[`create${model}`] = (doc, args, context, info) => context[schema.namespace].resolver.match(model).args(args).info(info).save(args.input);
            if (model.crud?.includes('u')) prev[`update${model}`] = (doc, args, context, info) => context[schema.namespace].resolver.match(model).args(args).info(info).save(args.input);
            if (model.crud?.includes('d')) prev[`delete${model}`] = (doc, args, context, info) => context[schema.namespace].resolver.match(model).args(args).info(info).delete();
            return prev;
          }, {}),
        } : {}),
        ...readModels.reduce((prev, model) => {
          return Object.assign(prev, {
            [model]: Object.values(model.fields).filter(field => field.model?.isEntity && field.crud?.includes('r')).reduce((prev2, field) => {
              return Object.assign(prev2, {
                [field]: (doc, args, context, info) => {
                  if (!doc.$) doc = context[schema.namespace].resolver.toResultSet(model, doc); // Ensure resultSet
                  return doc.$.lookup(field).args(args).info(info).resolve(info);
                },
              });
            }, {}),
          });
        }, {}),
      },
    };
  }

  static #getGQLType(field, suffix) {
    let { type } = field;
    const { isEmbedded, isRequired, isScalar, isArray, isArrayRequired, isPrimaryKey, defaultValue } = field;
    const modelType = `${type}${suffix}`;
    if (suffix && !isScalar) type = isEmbedded ? modelType : 'ID';
    type = isArray ? `[${type}${isArrayRequired ? '!' : ''}]` : type;
    if (!suffix && isRequired) type += '!';
    if (suffix === 'InputCreate' && !isPrimaryKey && isRequired && defaultValue == null) type += '!';
    return type;
  }

  static #getConnectionArguments(model) {
    return `
      where: ${model}InputWhere
      sortBy: ${model}InputSort
      limit: Int
      skip: Int
      first: Int
      after: String
      last: Int
      before: String
    `;
  }
};
