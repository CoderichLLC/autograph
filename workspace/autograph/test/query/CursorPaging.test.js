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

  // The documents being paged are raw driver documents (stored keys), and the driver reads the
  // decoded cursor by stored key. A sort on a field whose stored key differs from its name
  // (`age` → `my_age`, `id` → `_id`) must still produce a cursor that pages.
  describe('a sort on a field with a different stored key', () => {
    const AGES = [21, 32, 43, 54, 65];
    const decode = cursor => JSON.parse(Buffer.from(cursor, 'base64').toString('ascii'));
    let people;

    beforeAll(async () => {
      people = [];
      for (const [i, age] of AGES.entries()) {
        // Serial saves so that the ObjectIds (and so the `id` sort) follow AGES order.
        // eslint-disable-next-line no-await-in-loop
        people.push(await resolver.match('Person').save({ name: `paging-${i}`, emailAddress: `paging${i}@gmail.com`, age }));
      }
    });

    const scope = () => resolver.match('Person').where({ name: 'paging-*' });
    const ids = rs => rs.map(doc => `${doc.id}`);

    test('`endCursor` carries the sort value', async () => {
      const page = await scope().sort({ age: 'asc' }).first(2);
      expect(page.map(doc => doc.age)).toEqual([21, 32]);
      expect(Object.values(decode(page.$pageInfo.endCursor))).toEqual([32]);
    });

    test('`after` pages forward on a renamed field', async () => {
      const page = await scope().sort({ age: 'asc' }).first(2);
      const next = await scope().sort({ age: 'asc' }).after(page.$pageInfo.endCursor).first(2);
      expect(next.map(doc => doc.age)).toEqual([43, 54]);
      expect(next.$pageInfo.hasPreviousPage).toBe(true);
    });

    test('`before` pages backward on a renamed field', async () => {
      const page = await scope().sort({ age: 'asc' }).last(2);
      expect(page.map(doc => doc.age)).toEqual([54, 65]);
      const prev = await scope().sort({ age: 'asc' }).before(page.$pageInfo.startCursor).last(2);
      expect(prev.map(doc => doc.age)).toEqual([32, 43]);
      expect(prev.$pageInfo.hasNextPage).toBe(true);
    });

    test('`after` pages forward on `id`', async () => {
      const page = await scope().sort({ id: 'asc' }).first(2);
      expect(ids(page)).toEqual(ids(people.slice(0, 2)));
      const next = await scope().sort({ id: 'asc' }).after(page.$pageInfo.endCursor).first(2);
      expect(ids(next)).toEqual(ids(people.slice(2, 4)));
    });

    test('a cursor key that is not in the sort is ignored', async () => {
      // Forged: the driver compares a key that is not in the sort with `$lte`, and `email_address <= 'zzzz'`
      // matches every record, so the extra key would widen the page back to the start. The forged
      // string is not a record's own cursor, so no bookend is taken off.
      const forged = Buffer.from(JSON.stringify({ my_age: 54, email_address: 'zzzz' })).toString('base64');
      const next = await scope().sort({ age: 'asc' }).after(forged).first(2);
      expect(next.map(doc => doc.age)).toEqual([54, 65]);
    });

    test('`after` pages forward on `id` descending', async () => {
      const page = await scope().sort({ id: 'desc' }).first(2);
      expect(ids(page)).toEqual(ids(people.slice(3).reverse()));
      const next = await scope().sort({ id: 'desc' }).after(page.$pageInfo.endCursor).first(2);
      expect(ids(next)).toEqual(ids(people.slice(1, 3).reverse()));
    });
  });
});
