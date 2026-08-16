const Util = require('@coderich/util');

/**
 * AG's query-predicate VOCABULARY — the contract IR every driver implements.
 *
 * The `$`-operator syntax is not "MongoDB leaking through" — it is autograph's own intermediate
 * representation for expressing query intent, which deliberately borrowed MongoDB's proven wire
 * syntax ("why create your own?"). `$in` is how AG spells set membership; MongoDriver merely gets
 * to implement most of it by passthrough (the reference implementation), while every other driver
 * translates it to its own idiom (see PostgresDriver.buildWhereCallback).
 *
 * This module is the single source of truth for:
 *   - WHICH operators exist (the allowlist — anything else is rejected LOUDLY at the query
 *     boundary; generated GraphQL where-inputs are AutoGraphMixed, so arbitrary `$`-keys can
 *     arrive from untrusted callers and must never flow through unvalidated)
 *   - HOW each operator's value participates in field pipelines and glob conversion (`coerce`):
 *       'value' — the operand is field-shaped: field pipelines (normalize/serialize/cast) and
 *                 glob→regex conversion apply to it exactly as they do to an equality operand
 *       'list'  — an array of field-shaped operands: applied element-wise
 *       'none'  — the operand is vocabulary-shaped, not field-shaped ($exists takes a boolean);
 *                 pipelines and glob conversion must NOT touch it
 *
 * Semantics each operator must honor are pinned by the TestSuite's vocabulary-conformance
 * section — one test per operator per driver. `flags({ native })` mode is OUTSIDE this contract:
 * it is the developer's code-level declaration of TRUE driver dialect (raw column keys, raw
 * driver constructs like Mongo's $expr) — unvalidated and untranslated by design. The allowlist
 * guards the untrusted transformed path (where GraphQL's Mixed inputs arrive), not the explicit
 * escape hatch.
 */
const OPERATORS = {
  $eq: { coerce: 'value' },
  $ne: { coerce: 'value' },
  $gt: { coerce: 'value' },
  $gte: { coerce: 'value' },
  $lt: { coerce: 'value' },
  $lte: { coerce: 'value' },
  $in: { coerce: 'list' },
  $nin: { coerce: 'list' },
  $exists: { coerce: 'none' },
  $not: { coerce: 'nested' }, // field-level negation: its operand is ITSELF an operator object (or regex)
  // The LENGTH of the field's value — element count for arrays, CODE POINTS for String (the one
  // definition mongo $strLenCP, PG char_length and JS [...s].length agree on). Missing/null (and
  // a wrong-runtime-type value) count as size 0, so `{ tags: { $size: 0 } }` alone means "no
  // tags" — no $exists compound needed. Operand is a LENGTH, never a field value ('size'
  // coercion: pipelines and glob conversion must not touch it): a non-negative integer, or a
  // comparison object over non-negative integers. validate() additionally enforces: array/String
  // fields only, sole key of its operator object, never inside $not, and never through a dotted
  // path or inside an embedded-ARRAY where (drivers would measure the wrong thing — loud, not
  // wrong; the nested RELATION spelling `{ tags: { name: { $size: n } } }` is supported because
  // the planner/join re-roots it as a top-level query on the related model).
  $size: { coerce: 'size' },
};

// The comparison subset a $size operand may compose from. Not $in/$nin: a set of lengths has no
// measured use, and every driver would pay for it.
const SIZE_COMPARATORS = { $eq: true, $ne: true, $gt: true, $gte: true, $lt: true, $lte: true };

// COMPOUND operators compose whole where clauses (value = array of where clauses) and may
// appear at any object level, ALONGSIDE field keys (implicit AND — standard Mongo semantics).
// They are lifted and recursed by each traversal layer (transform/walk/finalize), never routed
// through field machinery.
const COMPOUNDS = {
  $or: true,
  $and: true,
};

const isOperatorKey = key => typeof key === 'string' && key.startsWith('$');

// A plain object whose keys are ALL operators — the vocabulary's value position, e.g.
// { $gte: 21, $lt: 65 }. Mixed objects ({ $gt: 5, name: 'x' }) are malformed (validate() rejects
// them); an object with SOME $-keys is still reported operator-shaped so traversals never
// mistake an operator for a field path.
const isOperatorObject = value => Util.isPlainObject(value)
  && Object.keys(value).length > 0
  && Object.keys(value).some(isOperatorKey);

// Map an operator object's operands through `fn`, honoring each operator's coercion class:
// 'value' applies fn to the operand, 'list' applies it element-wise, 'none' passes through
// untouched. Unknown operators pass through untouched (validate() is the rejection point —
// this is a pure transformation).
const mapValues = (obj, fn) => Object.entries(obj).reduce((prev, [op, value]) => {
  const coerce = OPERATORS[op]?.coerce;
  if (coerce === 'value') value = fn(value, op);
  else if (coerce === 'list') value = Array.isArray(value) ? value.map(el => fn(el, op)) : fn(value, op);
  else if (coerce === 'nested') value = Util.isPlainObject(value) ? mapValues(value, fn) : fn(value, op);
  return Object.assign(prev, { [op]: value });
}, {});

// Flatten a where clause by FIELD PATHS only — operator objects are vocabulary VALUES, never
// path segments. This is the operator-aware replacement for a generic Util.flatten anywhere a
// where clause is flattened: generic flattening turns `{ price: { $ne: -999 } }` into the key
// 'price.$ne', which MongoDB reads as a literal field path that silently matches nothing, and
// which the QueryPlanner misread as a JOIN sub-path (pre-querying the foreign model with a
// dangling operator that the transform then dropped — every relation operator degenerated to
// match-all). Operator objects stay INTACT as leaf values.
const flattenWhere = (obj, path = [], acc = {}) => {
  Object.entries(obj ?? {}).forEach(([key, value]) => {
    if (Util.isPlainObject(value) && !isOperatorObject(value) && Object.keys(value).length) flattenWhere(value, path.concat(key), acc);
    else acc[path.concat(key).join('.')] = value;
  });
  return acc;
};

// Walk a (possibly dotted) where key against the parsed model — DOMAIN field names, exactly what
// a caller writes. Numeric segments (array indices) stay on the current model; reaching a field
// with no model (a scalar — including custom object scalars like the dogfood's Place, and
// AutoGraphMixed) makes every deeper segment OPAQUE: the scalar's contents are the model's VALUE,
// not its shape, so there is nothing to check them against. Returns the model a nested-object
// value should recurse into (undefined at a scalar leaf). Throws on an unknown segment, naming
// the model it failed against and the declared alternatives.
const resolveField = (model, key, path) => {
  let field; // the TERMINAL field the key resolves to (last known field past a scalar leaf)
  let viaArray = false; // did the path traverse an ARRAY before its terminal segment ($size bars these)
  key.split('.').reduce((target, segment) => {
    if (!target || /^\d+$/.test(segment)) return target; // past a scalar, or an array index
    if (field?.isArray) viaArray = true;
    field = target.fields?.[segment];
    if (!field) throw new Error(`Unknown where field "${segment}" for ${target} at "${path.concat(key).join('.')}" — declared fields: ${Object.keys(target.fields ?? {}).join(', ')}. (\`flags({ native })\` is the escape hatch for raw storage keys.)`);
    return field.model;
  }, model);
  return { field, nested: field?.model, viaArray };
};

// `_` — the WIRE's vocabulary slot. The generated `<Model>InputWhere` keeps its typed fields
// (external clients hard-code the type name; introspection documents the fields) plus one
// optional `_: AutoGraphMixed` member carrying the full where IR the type system cannot express.
// This lift, applied by the generated resolvers, folds the slot back into the where it rides in —
// an implicit AND with its typed siblings, at ANY depth (every nested InputWhere has its own
// slot) — BEFORE the query boundary validates the whole, so the slot's content is schema-checked
// like everything else. MODEL-GUIDED recursion: it descends only into relation/embedded fields
// and compound branches, so a literal `_` key inside a Mixed scalar's DATA is never mistaken for
// the slot. The slot's own content is IR, taken verbatim (an `_` inside it is not a slot — it
// rejects at the boundary as an unknown field, loudly). `_` is wire-only: a LOCAL
// `.where({ _: … })` rejects the same way, and the parser refuses a model field named `_`.
const liftMixed = (model, where) => {
  if (!Util.isPlainObject(where)) return where;

  const { _, ...rest } = where;
  const lifted = Object.fromEntries(Object.entries(rest).map(([key, value]) => {
    if (COMPOUNDS[key] && Array.isArray(value)) return [key, value.map(branch => liftMixed(model, branch))];
    const field = model?.fields?.[key];
    if (field?.model && Util.isPlainObject(value) && !isOperatorObject(value)) return [key, liftMixed(field.model, value)];
    return [key, value];
  }));

  if (_ === undefined) return lifted;
  return Object.keys(lifted).length ? { $and: [lifted, _] } : _;
};

// Validate a (nested) where clause against the vocabulary. Every `$`-key must be a known
// operator; operator keys must not mix with field keys in one object; list-operators require
// arrays. Given a parsed MODEL, every field key must also resolve against it — at every depth,
// through dotted paths, into relation/embedded nested wheres, inside compound branches. Without
// this the typo'd key was WORSE than a wrong result: the domain→data key-walk silently DROPS
// unknown keys, so the predicate vanished and the query matched EVERYTHING. Throws with the
// allowlist / the declared fields in the message — the loud front door for anything the GraphQL
// Mixed where argument lets through, and the same guard for local callers, who never had one.
const validate = (where, path = [], model = undefined, position = 'clause', ctx = {}) => {
  if (!Util.isPlainObject(where)) return where;
  const { field, sizeBarred = false } = ctx;

  // Compound operators: value must be a non-empty array of where clauses; recurse each branch.
  // They coexist with field keys (implicit AND), so validate them and strip before the
  // value-operator analysis below.
  const compounds = Object.keys(where).filter(k => COMPOUNDS[k]);
  compounds.forEach((op) => {
    if (!Array.isArray(where[op]) || where[op].length === 0) throw new Error(`Where operator "${op}" at "${path.join('.') || '.'}" requires a non-empty array of where clauses`);
    where[op].forEach((branch, i) => validate(branch, path.concat(`${op}[${i}]`), model, 'clause', { sizeBarred })); // branches predicate the SAME model, in clause position
  });

  const keys = Object.keys(where).filter(k => !COMPOUNDS[k]);
  const opKeys = keys.filter(isOperatorKey);

  if (opKeys.length) {
    // POSITION matters: value operators apply to a FIELD, so they are only legal in a field's
    // VALUE position. An operator dangling in CLAUSE position (the where root, a compound
    // branch, or the root of a nested relation where) has no field to predicate — historically
    // the transform dropped it silently and the query matched EVERYTHING.
    if (position === 'clause') throw new Error(`Invalid where clause at "${path.join('.') || '.'}": operator${opKeys.length > 1 ? 's' : ''} ${opKeys.join(', ')} cannot stand alone — a value operator applies to a field, as in { field: { ${opKeys[0]}: … } }`);
    if (opKeys.length !== keys.length) throw new Error(`Invalid where clause at "${path.join('.') || '.'}": operator keys (${opKeys.join(', ')}) cannot mix with field keys in the same object`);
    // $not operands are themselves operator objects — recurse their operator keys.
    opKeys.forEach((op) => {
      if (op === '$not' && Util.isPlainObject(where[op])) {
        if (where[op].$size !== undefined) throw new Error(`Where operator "$size" at "${path.concat(op).join('.')}" cannot be negated with $not — flip the comparison instead`);
        validate(where[op], path.concat(op), undefined, 'value');
      }
    });
    opKeys.forEach((op) => {
      // Dotted-flat form ('field.$op' → '$op' arrives as the trailing segment pre-unflatten)
      const bare = op.slice(op.lastIndexOf('$'));
      if (!OPERATORS[bare]) throw new Error(`Unknown where operator "${op}" at "${path.join('.') || '.'}" — supported operators: ${Object.keys(OPERATORS).join(', ')}`);
      if (OPERATORS[bare].coerce === 'list' && !Array.isArray(where[op])) throw new Error(`Where operator "${op}" at "${path.join('.') || '.'}" requires an array value`);
    });
    if (where.$size !== undefined) {
      const at = path.join('.') || '.';
      // Sole key: missing counts as size 0, so composing $size with $exists (or anything else)
      // is redundant at best and contradictory at worst — and sole-key keeps every driver's
      // translation a single self-contained predicate.
      if (keys.length !== 1 || compounds.length) throw new Error(`Invalid where clause at "${at}": $size must be the sole operator of its object (missing counts as size 0 — composition is redundant)`);
      if (sizeBarred) throw new Error(`Where operator "$size" at "${at}" is not supported through dotted paths or inside embedded-array wheres — drivers would measure the wrong value. Predicate the field directly, or via a nested relation where.`);
      if (field && !(field.isArray || field.type === 'String')) throw new Error(`Where operator "$size" at "${at}" applies to array and String fields — "${field}" is ${field.type}`);
      const operand = where.$size;
      const ok = (Number.isInteger(operand) && operand >= 0)
        || (Util.isPlainObject(operand) && Object.keys(operand).length > 0
          && Object.entries(operand).every(([op, n]) => SIZE_COMPARATORS[op] && Number.isInteger(n) && n >= 0));
      if (!ok) throw new Error(`Where operator "$size" at "${at}" takes a non-negative integer or a comparison object over non-negative integers ({ ${Object.keys(SIZE_COMPARATORS).join('/')}: <int> })`);
    }
    return where;
  }

  keys.forEach((key) => {
    // Dotted keys may embed an operator as their final segment ('price.$ne') — validate it,
    // then resolve the FIELD prefix it applies to. ($size never rides the dotted-flat spelling —
    // its operand checks need the resolved field, which only the nested form threads through.)
    const segments = key.split('.');
    const last = segments[segments.length - 1];
    if (isOperatorKey(last)) {
      if (last === '$size' && segments.length > 1) throw new Error(`Where operator "$size" at "${path.concat(key).join('.')}" does not support the dotted spelling — write { ${segments.slice(0, -1).join('.')}: { $size: … } }`);
      if (!OPERATORS[last]) throw new Error(`Unknown where operator "${last}" at "${path.concat(key).join('.')}" — supported operators: ${Object.keys(OPERATORS).join(', ')}`);
      if (model && segments.length > 1) resolveField(model, segments.slice(0, -1).join('.'), path);
      return;
    }

    // Resolve the field path against the model (when one was given); a plain-object value on a
    // relation/embedded field is a NESTED WHERE and recurses against the related model. Operator
    // objects and scalar-leaf objects recurse model-less — operator checks only (a Mixed/custom-
    // scalar object is opaque data, not shape).
    const resolved = model ? resolveField(model, key, path) : undefined;
    if (resolved?.nested && Util.isPlainObject(where[key]) && !isOperatorObject(where[key])) {
      // Nested where — clause position. Crossing a RELATION re-roots the query (planner
      // pre-query / driver join), so $size is legal again inside; crossing an embedded ARRAY
      // stays on the same driver query where $size would measure the wrong value — barred.
      const crossed = resolved.field.isEmbedded ? (sizeBarred || resolved.field.isArray) : false;
      validate(where[key], path.concat(key), resolved.nested, 'clause', { sizeBarred: crossed });
    } else {
      // Value position: hand the terminal field along for $size's type check; a dotted or
      // array-traversing path bars $size outright (single-segment keys pass their field).
      const barred = sizeBarred || segments.length > 1 || Boolean(resolved?.viaArray);
      validate(where[key], path.concat(key), undefined, 'value', { field: segments.length === 1 ? resolved?.field : undefined, sizeBarred: barred });
    }
  });
  return where;
};

module.exports = { OPERATORS, COMPOUNDS, isOperatorKey, isOperatorObject, mapValues, flattenWhere, liftMixed, validate };
