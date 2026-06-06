const Util = require('@coderich/util');
const { Kind, parse, visit } = require('graphql');
const { mergeTypeDefs, mergeFields, mergeDirectives } = require('@graphql-tools/merge');
const { mergeDeep } = require('../service/AppService');
const Emitter = require('../data/Emitter');
const createFrameworkTypeDefs = require('./SchemaDirectives');
const { parseSchema, resolveNodeValue } = require('./SchemaParser');
const { generateApi, getConnectionArguments } = require('./SchemaApi');

const interfaceKinds = [Kind.INTERFACE_TYPE_DEFINITION, Kind.INTERFACE_TYPE_EXTENSION];
const modelKinds = [Kind.OBJECT_TYPE_DEFINITION, Kind.OBJECT_TYPE_EXTENSION].concat(interfaceKinds);
const operations = ['Query', 'Mutation', 'Subscription'];

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
    this.#typeDefs = createFrameworkTypeDefs(this.#config.directives);
  }

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
            const value = Util.uvl(resolveNodeValue(arg?.value), 'default');
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
   * Merge typeDefs and resolvers.
   *
   * On field-type conflict the incoming source wins by default — EXCEPT for input-type fields,
   * where the existing definition wins. The asymmetry covers `.api()`'s scaffolding:
   *   - Object-type extensions like `extend type X implements Node { id: ID! }` need to
   *     upgrade the decorator's nullable id to non-null so entities satisfy the Node interface.
   *   - Input-type fields generated as `input XInputCreate { cards: [ID] }` should defer to a
   *     user-supplied `extend input X { cards: [...] }` override.
   *
   * Connection wrapping (`authored: [Book] @field(connection: true)`) is no longer a merge
   * conflict — it's an in-place AST transform on the user's typeDefs (see `#rewriteConnections`).
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

      this.#typeDefs = mergeTypeDefs([typeDefs, this.#typeDefs], {
        noLocation: true,
        reverseDirectives: true,
        onFieldTypeConflict: (a, b, type) => {
          if (type?.kind === Kind.INPUT_OBJECT_TYPE_DEFINITION || type?.kind === Kind.INPUT_OBJECT_TYPE_EXTENSION) return b;
          return a;
        },
      });
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
    const { schema, typeDefs } = parseSchema(this.#config, this.#typeDefs);
    this.#schema = schema;
    this.#typeDefs = typeDefs;
    return this.#schema;
  }

  api() {
    // Parse first so model metadata is built from the original field shapes (e.g. `authored: [Book]`),
    // then rewrite the AST in place so the GraphQL schema sees `authored(args): BookConnection`.
    // Doing this as an explicit transform instead of a competing `extend type X { ... }` typeDef
    // removes one of the two reasons api() needed object-type incoming-wins; the other (Node
    // interface id upgrade) keeps the asymmetric merge resolver in place.
    const parsed = this.parse();
    this.#rewriteConnections();
    return this.merge(generateApi(parsed));
  }

  /**
   * Walk this.#typeDefs and rewrite fields marked `@field(connection: true)` so their type
   * becomes `XConnection` with the standard connection arguments, replacing the original
   * `[X]` array type. The Schema model already captured the original metadata during parse(),
   * so generated resolvers still know the field's underlying entity model.
   */
  #rewriteConnections() {
    const { directives: { field: fieldDir } } = this.#config;

    this.#typeDefs = visit(this.#typeDefs, {
      [Kind.FIELD_DEFINITION]: {
        enter: (node) => {
          const fdir = node.directives?.find(({ name }) => name.value === fieldDir);
          const connArg = fdir?.arguments?.find(({ name }) => name.value === 'connection');
          if (!connArg || resolveNodeValue(connArg.value) !== true) return undefined;

          // Walk past NON_NULL_TYPE / LIST_TYPE wrappers to find the named element type.
          let inner = node.type;
          while (inner && inner.kind !== Kind.NAMED_TYPE) inner = inner.type;
          const typeName = inner?.name?.value;
          if (!typeName) return undefined;

          const argString = getConnectionArguments(typeName);
          const stub = parse(`type _ { ${node.name.value}(${argString}): ${typeName}Connection }`, { noLocation: true });
          const replacement = stub.definitions[0].fields[0];
          return { ...node, type: replacement.type, arguments: replacement.arguments };
        },
      },
    });
  }

  framework() {
    this.#typeDefs = createFrameworkTypeDefs(this.#config.directives);
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
};
