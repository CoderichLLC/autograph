const Neo4jDriver = require('../src/Neo4jDriver');

describe('JS→Java regex translation (D10a)', () => {
  const t = re => Neo4jDriver.toJavaRegex(re);

  test('anchored glob output translates unwrapped', () => {
    expect(t(/^cent.*$/)).toBe('cent.*');
  });
  test('unanchored regex is wrapped for Neo4j full-string =~ semantics', () => {
    expect(t(/cent/)).toBe('.*cent.*');
  });
  test('case-insensitive flag becomes embedded (?i)', () => {
    expect(t(/^cent.*$/i)).toBe('(?i)cent.*');
  });
  test('picomatch-style non-capture groups and lazy quantifiers pass through', () => {
    expect(t(/^(?:cent[^/]*?)$/i)).toBe('(?i)(?:cent[^/]*?)');
  });
  test('named groups are rejected loudly (JS-only syntax)', () => {
    expect(() => t(/^(?<x>a)$/)).toThrow(/named group/i);
  });
});

// Neo4j's `=~` requires a STRING operand — a glob on a non-string field (Int/Boolean/Float)
// must cast the property before matching, or the comparison silently evaluates to null (no
// match, no error). Discovered via the live conformance suite: `age: '4?'` (Int) and
// `bestSeller: 'TRu?'` (Boolean) matched nothing until the where-translation wrapped the ref in
// toString(). Array fields need the cast applied per-element inside the containment check.
describe('non-string field regex casting (D10a)', () => {
  const buildWhere = (where, $schema) => Neo4jDriver.buildWhere(
    Neo4jDriver.unFlattenOperators(where),
    { params: {}, model: 'Person', $schema },
  );

  test('scalar non-string field is cast via toString() before =~', () => {
    const cypher = buildWhere({ bestSeller: /^TRu.$/i }, () => ({ type: 'Boolean' }));
    expect(cypher).toBe('toString(n.`bestSeller`) =~ $bestSeller');
  });

  test('array field casts each element via toString() before =~', () => {
    const cypher = buildWhere({ bids: /^1\..?.?$/ }, () => ({ type: 'Float', isArray: true }));
    expect(cypher).toBe('any(__x IN n.`bids` WHERE toString(__x) =~ $bids)');
  });

  // The neo4j-driver JS client binds a plain JS whole-number parameter as a Bolt FLOAT unless
  // explicitly wrapped in neo4j.int() — the write path doesn't do that — so an `Int`-typed
  // property can be physically stored as e.g. 40.0 rather than 40. Invisible to equality/range
  // predicates and reads, but toString() reveals it ("40.0" vs "40"), breaking regex matching.
  // Discovered via the live conformance suite: `age: '4?'` (Int) matched nothing until the cast
  // added toInteger() first. Float fields must NOT get this cast (it would truncate decimals).
  test('Int field gets an extra toInteger() pass to normalize Float mis-storage', () => {
    const cypher = buildWhere({ age: /^4.$/ }, () => ({ type: 'Int' }));
    expect(cypher).toBe('toString(toInteger(n.`age`)) =~ $age');
  });

  test('Float field is NOT truncated via toInteger() (decimal globs must survive)', () => {
    const cypher = buildWhere({ price: /^\d\.\d\d$/ }, () => ({ type: 'Float' }));
    expect(cypher).toBe('toString(n.`price`) =~ $price');
  });
});

// Bare-array / $in / $nin operands are LISTS of field-shaped operands — glob conversion applies
// per element (Vocabulary contract), so a list can mix literal values with glob-derived RegExps.
// Discovered via the live conformance suite: `bestSeller: ['TRu?']` (a bare single-element array
// on a scalar Boolean field) matched nothing — the array branch bound the RegExp straight into a
// single-param IN list, which can't express a regex test.
describe('regex-aware list matching (D10a)', () => {
  const buildWhere = (where, $schema) => Neo4jDriver.buildWhere(
    Neo4jDriver.unFlattenOperators(where),
    { params: {}, model: 'Book', $schema },
  );

  test('bare array with a single glob element ORs into the scalar regex form', () => {
    const cypher = buildWhere({ bestSeller: [/^TRu.$/i] }, () => ({ type: 'Boolean' }));
    expect(cypher).toBe('toString(n.`bestSeller`) =~ $bestSeller');
  });

  test('bare array mixing a literal with a glob element becomes an OR', () => {
    const cypher = buildWhere({ name: ['Richard', /^chri.*$/i] }, () => ({ type: 'String' }));
    expect(cypher).toBe('(toLower(n.`name`) = toLower($name) OR toString(n.`name`) =~ $name_1)');
  });

  test('purely-literal bare array keeps the single-param IN form (no regex present)', () => {
    const cypher = buildWhere({ name: ['Richard', 'Christie'] }, () => ({ type: 'String' }));
    expect(cypher).toBe('toLower(n.`name`) IN [__v IN $name | toLower(__v)]');
  });
});
