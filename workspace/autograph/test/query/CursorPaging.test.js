// Cursor pagination against a real driver.
//
// THE BUG THIS FILE EXISTS FOR: `#paginateResults` trims a leading and a trailing "bookend" record
// by comparing each end's `$cursor` to the `after`/`before` the caller supplied. With NEITHER
// supplied — and with no `sort`, so no `$cursor` is ever attached — both sides of that comparison
// are `undefined`, `undefined === undefined` is true, and the first and last records are dropped
// from a page nobody was paging through.
//
// Measured symptoms, before the fix:
//
//   .first(n)               →  n records, starting at the SECOND one
//   .where(…).first(n)      →  ZERO records, for every n, whenever the match set is small
//   .limit(n)               →  correct (classic paging never goes near this code)
//
// The second is the one that bites: it is silent. A `.one()` issued over the wire as
// `find(where, first: 1)` returns null for a document that demonstrably exists, and a
// `.one({ required: true })` 404s on it.
describe('cursor pagination', () => {
  let resolver;
  const NAMES = ['alpha', 'bravo', 'charlie', 'delta', 'echo'];
  const names = rs => rs.map(doc => doc.name);

  beforeAll(async () => {
    ({ resolver } = global);
    await Promise.all(NAMES.map(name => resolver.match('PlainJane').save({ name })));
  });

  // The regression that motivated all of this. `first` with a `where` returned nothing at all,
  // because the match set was smaller than the two bookends being taken off it.
  describe('a page is not silently emptied by bookends nobody asked for', () => {
    test('`where` + `first` returns the match, not an empty page', async () => {
      const rs = await resolver.match('PlainJane').where({ name: 'charlie' }).first(1);
      expect(names(rs)).toEqual(['charlie']);
    });

    test('a `where` matching exactly two survives `first: 1`', async () => {
      // The precise shape that failed: 2 matches, minus a leading bookend, minus a trailing one.
      const rs = await resolver.match('PlainJane').where({ name: ['alpha', 'bravo'] }).first(1);
      expect(rs).toHaveLength(1);
    });

    test('`first(n)` starts at the FIRST record, not the second', async () => {
      expect(names(await resolver.match('PlainJane').sort({ name: 'asc' }).first(2))).toEqual(['alpha', 'bravo']);
    });

    test('`last(n)` ends at the LAST record', async () => {
      expect(names(await resolver.match('PlainJane').sort({ name: 'asc' }).last(2))).toEqual(['delta', 'echo']);
    });

    test('asking for more than exists returns everything, not everything-minus-the-ends', async () => {
      expect(await resolver.match('PlainJane').first(50)).toHaveLength(NAMES.length);
    });
  });

  // Classic paging shares none of this code, and is the control: if these ever break, the cause is
  // somewhere else entirely.
  describe('classic paging is unaffected', () => {
    test('`limit` counts from the first record', async () => {
      expect(names(await resolver.match('PlainJane').sort({ name: 'asc' }).limit(2).many())).toEqual(['alpha', 'bravo']);
    });

    test('`skip` + `limit`', async () => {
      expect(names(await resolver.match('PlainJane').sort({ name: 'asc' }).skip(1).limit(2).many())).toEqual(['bravo', 'charlie']);
    });
  });

  // A REAL cursor must still be trimmed — the fix must not turn the bookend logic off, only stop it
  // from matching `undefined`.
  describe('a real cursor is still consumed as a bookend', () => {
    test('`after` excludes the record it names and reports hasPreviousPage', async () => {
      const page = await resolver.match('PlainJane').sort({ name: 'asc' }).first(2);
      expect(names(page)).toEqual(['alpha', 'bravo']);

      const next = await resolver.match('PlainJane').sort({ name: 'asc' }).after(page.$pageInfo.endCursor).first(2);
      expect(names(next)).toEqual(['charlie', 'delta']);
      expect(next.$pageInfo.hasPreviousPage).toBe(true);
    });

    test('paging to the end reports hasNextPage false', async () => {
      const page = await resolver.match('PlainJane').sort({ name: 'asc' }).skip(0).first(NAMES.length);
      expect(names(page)).toEqual(NAMES);
      expect(page.$pageInfo.hasNextPage).toBe(false);
    });
  });
});
