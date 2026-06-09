const Util = require('@coderich/util');
const { Kind, visit } = require('graphql');
const { isLeafValue } = require('../service/AppService');
const Transformer = require('../data/Transformer');
const Pipeline = require('../data/Pipeline');
const { $RAW } = require('../service/Symbols');

const operations = ['Query', 'Mutation', 'Subscription'];
const interfaceKinds = [Kind.INTERFACE_TYPE_DEFINITION, Kind.INTERFACE_TYPE_EXTENSION];
// const unionKinds = [Kind.UNION_TYPE_DEFINITION, Kind.UNION_TYPE_EXTENSION];
const enumKinds = [Kind.ENUM_TYPE_DEFINITION, Kind.ENUM_TYPE_EXTENSION];
const scalarKinds = [Kind.SCALAR_TYPE_DEFINITION, Kind.SCALAR_TYPE_EXTENSION];
const fieldKinds = [Kind.FIELD_DEFINITION];
const modelKinds = [Kind.OBJECT_TYPE_DEFINITION, Kind.OBJECT_TYPE_EXTENSION].concat(interfaceKinds);
const allowedKinds = modelKinds.concat(fieldKinds).concat(Kind.DOCUMENT, Kind.NON_NULL_TYPE, Kind.NAMED_TYPE, Kind.LIST_TYPE, Kind.DIRECTIVE).concat(scalarKinds).concat(enumKinds);
const pipelines = ['validate', 'construct', 'restruct', 'instruct', 'normalize', 'serialize', 'deserialize'];
const createPipelines = ['validate', 'construct', 'instruct', 'normalize', 'serialize'];
const updatePipelines = ['validate', 'restruct', 'instruct', 'normalize', 'serialize'];
// const validatePipelines = ['validate', 'instruct', 'normalize', 'serialize'];
const scalars = ['ID', 'String', 'Float', 'Int', 'Boolean'];

function resolveNodeValue(node) {
  if (node == null) return node;

  switch (node.kind) {
    case 'NullValue': return null;
    case 'ListValue': return node.values.map(resolveNodeValue);
    case 'EnumValueDefinition': return node.name.value;
    case 'EnumTypeDefinition': return node.values.map(resolveNodeValue);
    case 'ObjectValue': return node.fields.reduce((prev, field) => Object.assign(prev, { [field.name.value]: resolveNodeValue(field.value) }), {});
    default: return node.value ?? node;
  }
}

function findModelPathsToField($schema, model, field) {
  if (!model.isEmbedded) return [{ model, field, path: [`${field}`], isArray: field.isArray }];

  const arr = [];

  Object.values($schema.models).filter(m => m.isEntity).forEach((m) => {
    Util.traverse(Object.values(m.fields), (f, info) => {
      const path = info.path.concat(f.name);
      if (f.type === model.name) arr.push({ model: m, field, path: path.concat(`${field}`), isArray: info.isArray || field.isArray || f.isArray });
      else if (f.isEmbedded) return { value: Object.values(f.model.fields), info: { path, isArray: info.isArray || f.isArray } };
      return null;
    }, { path: [], isArray: false });
  });

  return arr;
}

/**
 * Parse typeDefs into a schema POJO. Returns { schema, typeDefs } where typeDefs is the
 * crud-pruned AST used for makeExecutableSchema (fields without 'r' in crud are removed).
 */
function parseSchema(config, typeDefs) {
  const { directives, namespace } = config;
  const $schema = { models: {}, enums: {}, scalars: {}, indexes: [], namespace };
  let target, model, field, isList;
  const thunks = [];

  // Parse AST (build/define $schema)
  visit(typeDefs, {
    enter: (node) => {
      const name = node.name?.value;

      if (!allowedKinds.includes(node.kind) || operations.includes(name)) return false;

      if (modelKinds.includes(node.kind)) {
        target = model = $schema.models[name] = {
          name,
          key: name,
          isInterface: interfaceKinds.includes(node.kind),
          interfaces: (node.interfaces || []).map(i => i.name.value),
          fields: {},
          crud: 'crud', // For use when creating API Queries and Mutations
          scope: 'crud', // For use when defining types (how it's field.model reference can be used)
          pkField: 'id',
          isEmbedded: true,
          isPersistable: true,
          source: config.dataSources?.default,
          loader: config.dataLoaders?.default,
          generator: config.generators?.default,
          pipelines: pipelines.reduce((prev, key) => Object.assign(prev, { [key]: [] }), {}),
          transformers: {
            validate: new Transformer({ args: { schema: $schema, path: [] } }),
            create: new Transformer({ args: { schema: $schema, path: [] } }),
            update: new Transformer({ args: { schema: $schema, path: [] } }),
            where: new Transformer({ args: { schema: $schema, path: [] } }),
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
        target = $schema.scalars[name] = {
          directives: {},
          pipelines: pipelines.reduce((prev, key) => Object.assign(prev, { [key]: [] }), {}),
        };
      }

      if (enumKinds.includes(node.kind)) {
        const values = resolveNodeValue(node);

        target = $schema.enums[name] = {
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
          $schema.indexes.push({ model });
        }

        node.arguments.forEach((arg) => {
          const key = arg.name.value;
          const value = resolveNodeValue(arg.value);
          target.directives[name][key] = value;

          if (name === directives.index) $schema.indexes[$schema.indexes.length - 1][key] = value;

          switch (`${name}-${key}`) {
            // Model specific directives
            case `${directives.model}-pk`: {
              model.pkField = value;
              break;
            }
            case `${directives.model}-source`: {
              model.source = config.dataSources?.[value];
              break;
            }
            case `${directives.model}-loader`: {
              model.loader = config.dataLoaders?.[value];
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
              target.generator = config.generators[value];
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

        // Model resolution after field resolution (push). Captured on the model so it can be
        // re-run after interface field-aggregation: aggregating implementer fields onto an
        // interface invalidates every fields-derived structure built here (transformers,
        // docTransform, ignorePaths), so interface models must rebuild these post-aggregation.
        $model.buildDerived = ($s) => {
          $model.ignorePaths = []; // reset — repopulated below; avoids dupes on re-run
          $model.resolvePath = (path, prop = 'name') => $schema.resolvePath(`${$model[prop]}.${path}`, prop);

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

              // Persist:false embedded fields are transient — used for derivation in custom
              // resolvers/setup hooks, not stored. Storage-integrity validation (ensureFK,
              // required) on their subtree fights this pattern; skip the embedded validate
              // transform entirely. Custom validators on the parent field still run.
              if (curr.isEmbedded && curr.isPersistable !== false) {
                rules.push(a => Util.map(a.value, (value, i) => {
                  const path = a.path.concat(curr.name);
                  if (curr.isArray) path.push(i);
                  return curr.model.transformers.validate.transform(value, { ...args, thunks: a.thunks, query: a.query, resolver: a.resolver, context: a.context, path });
                }));
              }

              rules.push(a => Pipeline.$validate({ ...a, ...args, path: a.path.concat(curr.name) }));

              return Object.assign(prev, { [curr.name]: rules });
            }, {}),
            // Seed defaults so validate iterates every field with validate-pipeline rules
            // (covers required-field checks for fields the user didn't provide).
            defaults: Object.values($model.fields).reduce((prev, curr) => {
              if (curr.pipelines.validate.length || curr.isEmbedded) return Object.assign(prev, { [curr.name]: undefined });
              return prev;
            }, {}),
          });

          // Deserialize/docs special case handling for performance. docTransform expects raw
          // DB-shape input and produces GraphQL-shape output. It must be idempotent because
          // the default field resolver re-wraps embedded sub-docs via toResultSet — and those
          // children were already transformed during the parent's read. The non-enumerable
          // $transformed marker lets a second call short-circuit without altering semantics.
          const docFields = Object.values($model.fields);
          $model.docTransform = (doc, args = {}, selection) => {
            if (doc == null || typeof doc !== 'object') return doc;
            if (doc.$transformed) return doc;
            // Look up the per-(resolver, model) DocClass from the resolver. Auto-propagating
            // through embedded recursion this way means sub-docs also get the right prototype
            // + shared lazy getters without the caller threading a Ctor down. When no resolver
            // is available (legacy callers, tests), Ctor is undefined → falls back to {}.
            const Ctor = args.resolver?.getDocClass?.($model);
            const lazyGetters = Ctor?.lazyGetters;
            const lazySetters = Ctor?.lazySetters;
            // selection (built once at the top-level toResultSet call, passed explicitly
            // rather than via args to avoid spreading args on every embedded recursion) tells
            // us which transform-eligible fields the GraphQL caller asked for. Selected →
            // eager (run transform now, store data property). Unselected → lazy (defer behind
            // a shared getter; if a hook/spread reads it later, the getter still fires).
            // When selection is undefined (embedded recursion from a lazy getter, non-
            // GraphQL caller), every eligible field is lazy.
            const out = Ctor ? new Ctor() : {};
            for (const docField of docFields) {
              let value = docField.key in doc ? doc[docField.key] : docField.defaultValue;
              if (value === undefined) continue; // eslint-disable-line
              if (docField.isArray) value = value == null ? value : Util.ensureArray(value);
              const hasEmbedded = docField.isEmbedded;
              const hasDeserialize = docField.pipelines.deserialize.length > 0;
              const isEligible = (hasEmbedded || hasDeserialize) && value != null;
              const isSelected = selection ? selection.fields.has(docField.name) : false;
              const goLazy = lazyGetters && isEligible && !isSelected;

              if (goLazy) {
                // LAZY: shared getter on the DocClass; raw value goes in this[$RAW][name]
                // for the getter to consume on first access.
                if (!out[$RAW]) out[$RAW] = {};
                out[$RAW][docField.name] = value;
                Object.defineProperty(out, docField.name, {
                  enumerable: true,
                  configurable: true,
                  get: lazyGetters[docField.name],
                  set: lazySetters[docField.name],
                });
                continue; // eslint-disable-line
              }

              // EAGER. Pass the sub-selection straight through as the third arg — no spread
              // needed, args itself is unchanged. If selection is undefined or doesn't have
              // this field's embedded sub-tree, sub-doc gets undefined → all-lazy.
              if (hasEmbedded) {
                const subSelection = selection?.embedded?.[docField.name];
                value = Util.map(value, v => docField.model.docTransform(v, args, subSelection));
              }
              if (hasDeserialize) {
                value = Pipeline.resolve({ ...args, model: $model, field: docField, value }, 'deserialize');
              }
              out[docField.name] = value;
            }
            Object.defineProperty(out, '$transformed', { value: true });
            return out;
          };

          Util.traverse(Object.values($model.fields), (f, info) => {
            const path = info.path.concat(f.name);
            if (f.isEmbedded) return { value: Object.values(f.model.fields), info: { path } };
            if (f.isScalar) $model.ignorePaths.push(path.join('.'));
            return null;
          }, { path: [] });
        };

        thunks.push($model.buildDerived);
      } else if (node.kind === Kind.FIELD_DEFINITION) {
        const $field = field;
        const $model = model;

        field.isPrimaryKey = Boolean(field.name === model.pkField);
        field.isPersistable = Util.uvl(field.isPersistable, model.isPersistable, true);

        // Field resolution comes first (unshift)
        thunks.unshift(($s) => {
          $field.model = $s.models[$field.type];
          $field.linkTo = $s.models[$field.linkTo];
          $field.crud = Util.uvl($field.crud, $field.model?.scope, 'crud');
          $field.linkBy ??= $field.linkTo?.pkField; // Join key on the LINKED model — used when this side is virtual (set via @link(by:))
          $field.fkField ??= $field.linkTo?.pkField; // Property to extract from FK-input objects + join target for stored FKs (set via @field(fk:))
          $field.linkField = $field.isVirtual ? $model.fields[$model.pkField] : $field;
          $field.isFKReference = $field.fkField && !$field.isPrimaryKey && $field.model?.isMarkedModel && !$field.model?.isEmbedded;
          $field.isEmbedded = Boolean($field.model && !$field.isFKReference && !$field.isPrimaryKey);
          $field.isScalar = scalars.includes($field.type);
          $field.isEnum = Boolean($s.enums[$field.type]);
          $field.generator ??= $model.generator;

          // Referential Integrity Setup
          if ($field.onDelete) $field.model.referentialIntegrity.push(...findModelPathsToField($schema, $model, $field));

          // Merge Enums and Scalar type definitions
          const enumer = $s.enums[$field.type];
          const scalar = $s.scalars[$field.type];
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

          // FK plumbing (join construction + ensureFK) only applies to persisted FK fields.
          // A persist:false field has no data on the parent doc, so the join is unreachable
          // and ensureFK has nothing to validate against — it's a custom-resolver field.
          if ($field.isFKReference && $field.isPersistable !== false) {
            const to = $field.model.key;
            // Virtual side: join `linkTo[linkBy]` against this model's pk (linkBy names the FK column on the linked model).
            // Straight FK side: join `linkTo[fkField]` against this field's stored value (fkField names the linked column our value targets).
            const on = $field.linkTo.fields[$field.isVirtual ? $field.linkBy : $field.fkField].key;
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
  thunks.forEach(thunk => thunk($schema));

  // Aggregate implementer fields onto interface models so generated inputs/pipelines cover the
  // full union of concrete fields — no need to re-declare every implementer field on the
  // interface. Add-if-absent: the interface's own field definition always wins.
  Object.values($schema.models).filter(m => m.isInterface).forEach((iface) => {
    iface.discriminator = iface.directives?.model?.discriminator || 'type';
    iface.oneOf = Boolean(iface.directives?.model?.oneOf); // emit a @oneOf input instead of a fat union
    iface.typeMap = {}; // discriminator value -> concrete (implementer) type name, for __resolveType
    Object.values($schema.models).forEach((impl) => {
      if (impl.isInterface || !impl.interfaces?.includes(iface.name)) return;
      Object.values(impl.fields).forEach((f) => { iface.fields[f.name] ??= f; });
      iface.typeMap[impl.directives?.model?.typeKey ?? impl.name] = impl.name;
    });

    // Field set just changed — rebuild the interface's fields-derived structures (transformers,
    // docTransform, ignorePaths) so implementer fields survive the write/read round-trip. The
    // strictSchema create/update transformers would otherwise strip any field absent from the
    // shape that was frozen pre-aggregation.
    iface.buildDerived($schema);

    // oneOf interfaces receive a polymorphic wrapper input ({ <typeKey>: {...} }) rather than the
    // fat field shape. Override create/update with a dispatcher: unwrap the single key, route the
    // inner value through the CONCRETE model's transformer, and stamp the discriminator (= typeKey)
    // so the stored doc is a flat concrete doc that __resolveType can map on read. validate/toDriver
    // need no special-casing — they run on the already-flattened concrete doc via aggregated fields.
    if (iface.oneOf) {
      const dispatch = (crud, v, args) => {
        if (!Util.isPlainObject(v)) return v;
        const [typeKey, inner] = Object.entries(v)[0] || [];
        const concrete = $schema.models[iface.typeMap[typeKey]];
        if (!concrete || !Util.isPlainObject(inner)) return v;
        const out = concrete.transformers[crud].transform(inner, args);
        out[iface.discriminator] = typeKey;
        return out;
      };

      ['create', 'update'].forEach((crud) => {
        iface.transformers[crud] = { transform: (value, args) => Util.map(value, v => dispatch(crud, v, args)) };
      });
    }
  });

  // Resolve indexes
  $schema.indexes = $schema.indexes.map((index) => {
    const { key } = index.model;
    const { name, type } = index;
    const on = index.on.map(f => index.model.fields[f].key);
    return { key, name, type, on };
  });

  // Helper methods
  const resolvePathCache = {};
  $schema.resolvePath = (path, prop = 'key') => {
    resolvePathCache[path] ??= (() => {
      const [modelKey, ...fieldKeys] = path.split('.');
      const $model = Object.values($schema.models).find(el => el[prop] === modelKey);
      if (!$model || !fieldKeys.length) return $model;
      return fieldKeys.reduce((parent, key) => Object.values(parent.fields || parent.model?.fields || {}).find(el => el[prop] === key) || parent, $model);
    })();
    return resolvePathCache[path];
  };

  // Prune typeDefs: remove fields that lack read ('r') crud access
  let $model;
  const prunedTypeDefs = visit(typeDefs, {
    enter: (node) => {
      const name = node.name?.value;
      if (!allowedKinds.includes(node.kind) || operations.includes(name)) return false;

      if (modelKinds.includes(node.kind)) {
        $model = $schema.models[name];
      } else if (fieldKinds.includes(node.kind)) {
        if (!Util.uvl($model?.fields[name]?.crud, 'crud')?.includes('r')) return null;
      }

      return undefined;
    },
  });

  return { schema: $schema, typeDefs: prunedTypeDefs };
}

module.exports = { parseSchema, resolveNodeValue };
