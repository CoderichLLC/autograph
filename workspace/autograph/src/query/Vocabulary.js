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
};

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

// Walk a (possibly dotted) where key against the parsed model — DOMAIN field names, exactly what
// a caller writes. Numeric segments (array indices) stay on the current model; reaching a field
// with no model (a scalar — including custom object scalars like the dogfood's Place, and
// AutoGraphMixed) makes every deeper segment OPAQUE: the scalar's contents are the model's VALUE,
// not its shape, so there is nothing to check them against. Returns the model a nested-object
// value should recurse into (undefined at a scalar leaf). Throws on an unknown segment, naming
// the model it failed against and the declared alternatives.
const resolveField = (model, key, path) => {
  return key.split('.').reduce((target, segment) => {
    if (!target || /^\d+$/.test(segment)) return target; // past a scalar, or an array index
    const field = target.fields?.[segment];
    if (!field) throw new Error(`Unknown where field "${segment}" for ${target} at "${path.concat(key).join('.')}" — declared fields: ${Object.keys(target.fields ?? {}).join(', ')}. (\`flags({ native })\` is the escape hatch for raw storage keys.)`);
    return field.model;
  }, model);
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
const validate = (where, path = [], model = undefined) => {
  if (!Util.isPlainObject(where)) return where;

  // Compound operators: value must be a non-empty array of where clauses; recurse each branch.
  // They coexist with field keys (implicit AND), so validate them and strip before the
  // value-operator analysis below.
  const compounds = Object.keys(where).filter(k => COMPOUNDS[k]);
  compounds.forEach((op) => {
    if (!Array.isArray(where[op]) || where[op].length === 0) throw new Error(`Where operator "${op}" at "${path.join('.') || '.'}" requires a non-empty array of where clauses`);
    where[op].forEach((branch, i) => validate(branch, path.concat(`${op}[${i}]`), model)); // branches predicate the SAME model
  });

  const keys = Object.keys(where).filter(k => !COMPOUNDS[k]);
  const opKeys = keys.filter(isOperatorKey);

  if (opKeys.length) {
    if (opKeys.length !== keys.length) throw new Error(`Invalid where clause at "${path.join('.') || '.'}": operator keys (${opKeys.join(', ')}) cannot mix with field keys in the same object`);
    // $not operands are themselves operator objects — recurse their operator keys.
    opKeys.forEach((op) => { if (op === '$not' && Util.isPlainObject(where[op])) validate(where[op], path.concat(op)); });
    opKeys.forEach((op) => {
      // Dotted-flat form ('field.$op' → '$op' arrives as the trailing segment pre-unflatten)
      const bare = op.slice(op.lastIndexOf('$'));
      if (!OPERATORS[bare]) throw new Error(`Unknown where operator "${op}" at "${path.join('.') || '.'}" — supported operators: ${Object.keys(OPERATORS).join(', ')}`);
      if (OPERATORS[bare].coerce === 'list' && !Array.isArray(where[op])) throw new Error(`Where operator "${op}" at "${path.join('.') || '.'}" requires an array value`);
    });
    return where;
  }

  keys.forEach((key) => {
    // Dotted keys may embed an operator as their final segment ('price.$ne') — validate it,
    // then resolve the FIELD prefix it applies to.
    const segments = key.split('.');
    const last = segments[segments.length - 1];
    if (isOperatorKey(last)) {
      if (!OPERATORS[last]) throw new Error(`Unknown where operator "${last}" at "${path.concat(key).join('.')}" — supported operators: ${Object.keys(OPERATORS).join(', ')}`);
      if (model && segments.length > 1) resolveField(model, segments.slice(0, -1).join('.'), path);
      return;
    }

    // Resolve the field path against the model (when one was given); a plain-object value on a
    // relation/embedded field is a NESTED WHERE and recurses against the related model. Operator
    // objects and scalar-leaf objects recurse model-less — operator checks only (a Mixed/custom-
    // scalar object is opaque data, not shape).
    const nested = model ? resolveField(model, key, path) : undefined;
    if (nested && Util.isPlainObject(where[key]) && !isOperatorObject(where[key])) validate(where[key], path.concat(key), nested);
    else validate(where[key], path.concat(key));
  });
  return where;
};

module.exports = { OPERATORS, COMPOUNDS, isOperatorKey, isOperatorObject, mapValues, liftMixed, validate };
