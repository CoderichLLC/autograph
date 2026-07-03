const Util = require('@coderich/util');
const { Kind, parse, visit } = require('graphql');
const { mergeTypeDefs, mergeFields, mergeDirectives } = require('@graphql-tools/merge');
const { mergeDeep } = require('../service/AppService');
const Emitter = require('../data/Emitter');
const createFrameworkTypeDefs = require('./SchemaDirectives');
const { parseSchema, resolveNodeValue } = require('./SchemaParser');
const { generateApi, getConnectionArguments } = require('./SchemaApi');
const { wrapOperationScope } = require('./OperationScope');

const interfaceKinds = [Kind.INTERFACE_TYPE_DEFINITION, Kind.INTERFACE_TYPE_EXTENSION];
const modelKinds = [Kind.OBJECT_TYPE_DEFINITION, Kind.OBJECT_TYPE_EXTENSION].concat(interfaceKinds);
// Inheritance injects fields into the canonical *definition* nodes only. Injecting into both a type's
// definition AND its extension would declare the same field twice ("Field X can only be defined once").
const inheritKinds = [Kind.OBJECT_TYPE_DEFINITION, Kind.INTERFACE_TYPE_DEFINITION];
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
    this.#config.directives.transaction ??= 'transaction';
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
   * Interface -> implementer field inheritance.
   *
   * GraphQL has no object-type `extends`: a type that `implements` an interface must physically declare
   * every interface field or `makeExecutableSchema` throws. Rather than re-declare them in every `.graphql`,
   * copy each interface's fields (with their directives) into its implementers, add-if-absent so an
   * implementer's own declaration always wins (covariant narrowing / per-field directive overrides).
   *
   * Runs before parse() builds models, so the inherited fields reach BOTH the emitted typeDefs (valid
   * executable schema) AND the internal $schema (inherited @field directives/pipelines/defaults apply to
   * the concrete model). Safe to make automatic: GraphQL already mandates implementers expose every
   * interface field, so this can only remove boilerplate, never produce an invalid schema. Schemas that
   * still re-declare (the legacy pattern) are unaffected — the field is already present, so injection skips it.
   */
  #inheritInterfaceFields() {
    // Index interface field sets by name, unioning definition + extension nodes. Also record what each
    // interface itself implements, for transitive (interface-implements-interface) resolution.
    const interfaceFields = {}; // name -> Map(fieldName -> FieldDefinitionNode)
    const interfaceParents = {}; // name -> [parent interface names]

    this.#typeDefs.definitions.forEach((node) => {
      if (!interfaceKinds.includes(node.kind)) return;
      const name = node.name.value;
      const fields = (interfaceFields[name] ??= new Map());
      (node.fields || []).forEach(f => fields.has(f.name.value) || fields.set(f.name.value, f));
      (interfaceParents[name] ??= []).push(...(node.interfaces || []).map(i => i.name.value));
    });

    // Expand each interface's field set with its parents' fields, resolving in dependency order.
    const resolving = new Set();
    const resolved = new Set();
    const expand = (name) => {
      if (resolved.has(name) || !interfaceFields[name]) return;
      if (resolving.has(name)) throw new Error(`Interface inheritance cycle detected at "${name}"`);
      resolving.add(name);
      (interfaceParents[name] || []).forEach((parent) => {
        expand(parent);
        interfaceFields[parent]?.forEach((f, fname) => interfaceFields[name].has(fname) || interfaceFields[name].set(fname, f));
      });
      resolving.delete(name);
      resolved.add(name);
    };
    Object.keys(interfaceFields).forEach(expand);

    // Inject the (transitively resolved) interface fields into each implementing definition, existing-wins.
    const config = { noLocation: true, onFieldTypeConflict: (f, a, b) => a };
    this.#typeDefs = visit(this.#typeDefs, {
      enter: (node) => {
        if (!inheritKinds.includes(node.kind) || operations.includes(node.name.value)) return undefined;
        // Union the implemented interfaces' fields by name (a type may implement an interface AND its
        // parent, e.g. `implements Mid & Base`, surfacing the same field twice).
        const incoming = new Map();
        (node.interfaces || []).forEach(i => interfaceFields[i.name.value]?.forEach((f, fname) => incoming.has(fname) || incoming.set(fname, f)));
        if (!incoming.size) return undefined;
        return { ...node, fields: mergeFields(node, node.fields || [], [...incoming.values()], config) };
      },
    });

    return this;
  }

  /**
   * Parse typeDefs; returning a schema POJO
   */
  parse() {
    if (this.#schema) return this.#schema;
    this.#inheritInterfaceFields();
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
      // Root Mutation resolvers (user-defined included — they were merged in with precedence
      // above) leave here wrapped in the operation-scope decorator: a multi-root-field mutation
      // operation carrying @transaction is one all-or-nothing unit of work, with no host
      // integration. Without the directive the wrapper is a pure passthrough (spec-standard
      // partial-success semantics). The wrap is unwrap-and-rewrap idempotent, so merge() paths
      // that feed one Schema's toObject() into another cannot double-wrap. See OperationScope.js.
      resolvers: wrapOperationScope(this.#resolvers, this.#config.namespace, this.#config.directives.transaction),
    };
  }

  makeExecutableSchema() {
    return this.#config.makeExecutableSchema(this.toObject());
  }
};
