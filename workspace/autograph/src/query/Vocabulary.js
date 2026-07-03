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

// Validate a (nested) where clause against the vocabulary. Every `$`-key must be a known
// operator; operator keys must not mix with field keys in one object; list-operators require
// arrays. Throws with the full allowlist in the message — the loud front door for anything the
// GraphQL Mixed inputs let through.
const validate = (where, path = []) => {
  if (!Util.isPlainObject(where)) return where;

  // Compound operators: value must be a non-empty array of where clauses; recurse each branch.
  // They coexist with field keys (implicit AND), so validate them and strip before the
  // value-operator analysis below.
  const compounds = Object.keys(where).filter(k => COMPOUNDS[k]);
  compounds.forEach((op) => {
    if (!Array.isArray(where[op]) || where[op].length === 0) throw new Error(`Where operator "${op}" at "${path.join('.') || '.'}" requires a non-empty array of where clauses`);
    where[op].forEach((branch, i) => validate(branch, path.concat(`${op}[${i}]`)));
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
    // Dotted keys may embed an operator as their final segment ('price.$ne') — validate it.
    const last = key.split('.').pop();
    if (isOperatorKey(last)) {
      if (!OPERATORS[last]) throw new Error(`Unknown where operator "${last}" at "${path.concat(key).join('.')}" — supported operators: ${Object.keys(OPERATORS).join(', ')}`);
      return;
    }
    validate(where[key], path.concat(key));
  });
  return where;
};

module.exports = { OPERATORS, COMPOUNDS, isOperatorKey, isOperatorObject, mapValues, validate };
