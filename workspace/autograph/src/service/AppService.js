const { inspect } = require('node:util');
const Util = require('@coderich/util');
const PicoMatch = require('picomatch');
const FillRange = require('fill-range');
const ObjectHash = require('object-hash');
const ObjectId = require('bson-objectid');
const DeepMerge = require('deepmerge');

exports.isGlob = str => typeof str === 'string' && (str.startsWith('!') || PicoMatch.scan(str).isGlob);
exports.globToRegex = (glob, options = {}) => PicoMatch.makeRe(glob, { nocase: true, ...options, expandRange: (a, b) => `(${FillRange(a, b, { toRegex: true })})` });

const smartMerge = (target, source, options) => source;
exports.isLeafValue = value => Array.isArray(value) || value instanceof Date || ObjectId.isValid(value) || Util.isScalarValue(value);
exports.mergeDeep = (...args) => DeepMerge.all(args, { isMergeableObject: obj => (Util.isPlainObjectOrArray(obj)), arrayMerge: smartMerge });
exports.hashObject = obj => ObjectHash(obj, { respectType: false, respectFunctionNames: false, respectFunctionProperties: false, unorderedArrays: true, ignoreUnknown: true, replacer: r => (ObjectId.isValid(r) ? `${r}` : r) });
exports.fromGUID = guid => Buffer.from(`${guid}`, 'base64').toString('ascii').split(',');
exports.guidToId = (autograph, guid) => exports.uvl(exports.fromGUID(guid)[1], guid);
exports.inspect = (obj, opts = { showHidden: false, colors: true, depth: 5 }) => console.log(inspect(obj, opts)); // eslint-disable-line no-console

exports.getGQLReturnType = (info) => {
  const returnType = `${info.returnType}`;
  const typeMap = { array: /^\[.+\].?$/, connection: /.+Connection!?$/, number: /^(Int|Float)!?$/, scalar: /.*/ };
  return Object.entries(typeMap).find(([type, pattern]) => returnType.match(pattern))[0];
};

// Selection tree built from a GraphQL resolve `info` by walking the AST directly. We
// deliberately avoid `graphql-parse-resolve-info` (and any path that touches `info.returnType`
// / `info.schema`) because those do `instanceof` checks against GraphQL type classes. When
// there are two copies of the `graphql` package in node_modules (common with npm link / yarn
// workspaces / monorepos), the realms mismatch and the library throws "Cannot use GraphQLList
// ... from another module or realm." The AST itself is plain data (no class instances), so
// walking `info.fieldNodes` + `info.fragments` is realm-safe regardless of how `graphql` is
// resolved across packages.
//
// Result shape: { fields: Set<string>, embedded: { [fieldName]: <same shape> } }

const mergeTreeInto = (target, source) => {
  for (const f of source.fields) target.fields.add(f);
  for (const [k, sub] of Object.entries(source.embedded)) {
    if (target.embedded[k]) mergeTreeInto(target.embedded[k], sub);
    else target.embedded[k] = sub;
  }
};

const walkSelectionSet = (selectionSet, fragments) => {
  const result = { fields: new Set(), embedded: {} };
  if (!selectionSet || !selectionSet.selections) return result;
  for (const sel of selectionSet.selections) {
    switch (sel.kind) {
      case 'Field': {
        const name = sel.name.value;
        if (name === '__typename') break;
        result.fields.add(name);
        if (sel.selectionSet) {
          const sub = walkSelectionSet(sel.selectionSet, fragments);
          if (result.embedded[name]) mergeTreeInto(result.embedded[name], sub);
          else result.embedded[name] = sub;
        }
        break;
      }
      case 'FragmentSpread': {
        // info.fragments is a plain { [name]: FragmentDefinitionNode } map — pure AST data.
        const frag = fragments[sel.name.value];
        if (frag) mergeTreeInto(result, walkSelectionSet(frag.selectionSet, fragments));
        break;
      }
      case 'InlineFragment': {
        // Merge across the inline fragment's selectionSet. We intentionally don't filter by
        // typeCondition — selection-aware-lazy only cares whether a field name was asked for.
        // Fields that don't belong to this model simply won't match any docField and are
        // ignored downstream. Avoids needing schema-type lookups (realm-bound).
        mergeTreeInto(result, walkSelectionSet(sel.selectionSet, fragments));
        break;
      }
      default: break; // Unknown selection kinds (future-proofing)
    }
  }
  return result;
};

// Memoized per `info.fieldNodes` ARRAY, not per `info`: graphql-js builds a fresh info object
// for every resolver invocation (N parents resolving the same link field = N distinct infos),
// but it memoizes collectSubfields — so all N siblings share the fieldNodes array by IDENTITY
// within a request. Keying on the array collapses those N identical walks to one, and the
// per-request lifetime holds (fresh arrays per execution context; WeakMap entries GC with the
// request). Infos sharing fieldNodes share fragments too (same document), so the walk inputs
// are provably identical. The tree is read-only to every consumer (docTransform only reads
// fields/embedded), so sharing it is safe; only doc INSTANCES must stay per-call. (modelName
// does not shape the tree — the walk is selection-driven.)
const selectionTrees = new WeakMap();

exports.buildSelectionTree = (info, modelName) => {
  if (!info || !info.fieldNodes || !info.fieldNodes.length) return null;
  if (selectionTrees.has(info.fieldNodes)) return selectionTrees.get(info.fieldNodes);
  let out = null;
  try {
    const fragments = info.fragments || {};
    // A resolver can technically receive multiple fieldNodes (the same field selected with
    // different aliases); merge their sub-selections together so we don't miss anything.
    const tree = { fields: new Set(), embedded: {} };
    for (const node of info.fieldNodes) {
      if (node.selectionSet) mergeTreeInto(tree, walkSelectionSet(node.selectionSet, fragments));
    }
    // Connection-shape: { count, edges { node { ... } }, pageInfo }. The actual model
    // selection sits two levels deep. If we see that shape, drill into it. Otherwise the tree
    // is already the model selection (get<Model>, mutations, plain findMany).
    out = (tree.embedded.edges && tree.embedded.edges.embedded.node) || tree;
  } catch {
    out = null;
  }
  selectionTrees.set(info.fieldNodes, out);
  return out;
};

exports.JSONParse = (mixed) => {
  try {
    const json = JSON.parse(mixed);
    return json;
  } catch {
    return undefined;
  }
};
