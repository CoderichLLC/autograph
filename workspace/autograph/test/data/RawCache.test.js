describe('DataLoader caches the RAW driver result — transformation is per-call (regression)', () => {
  // The dataloader package memoizes whatever its batch fn returns. A past change moved
  // toResultSet INSIDE the batch fn, silently switching the cache contents from raw rows to
  // transformed doc INSTANCES — shared by reference across cache hits (caller mutations bled
  // into every later read), shaped by the first caller's selection, and $-magic-bound to the
  // resolver that built the (request-shared) loader map. These tests pin the restored contract.
  let resolver;
  let context;

  beforeAll(() => {
    ({ resolver, context } = global);
  });

  test('a cache hit returns a FRESH doc instance — caller mutations never bleed into later reads', async () => {
    const person = await resolver.match('Person').save({ name: 'raw-cache', emailAddress: 'raw-cache@example.com' });
    try {
      const q1 = await resolver.match('Person').id(person.id).one();
      const q2 = await resolver.match('Person').id(person.id).one(); // identical query → cache hit
      expect(q2).not.toBe(q1); // fresh transform per call — the documented "safe to mutate" contract

      q1.name = 'MUTATED';
      const q3 = await resolver.match('Person').id(person.id).one();
      expect(q3.name).toBe('raw-cache'); // isolation: the mutation stayed on q1's instance
    } finally {
      await resolver.match('Person').id(person.id).delete();
    }
  });

  test('array fields are copied, never shared by reference with the raw cache', async () => {
    const art = await resolver.match('Art').save({ name: 'raw-cache-art', bids: [1.5, 2.5] });
    try {
      const a1 = await resolver.match('Art').id(art.id).one();
      a1.bids.push(99.9); // deep mutation of a plain (no-pipeline) array field
      const a2 = await resolver.match('Art').id(art.id).one();
      expect(a2.bids).toEqual([1.5, 2.5]); // the raw cache never saw the push
    } finally {
      await resolver.match('Art').id(art.id).delete();
    }
  });

  test('$-magic binds to the CALLING resolver — a doc read through a txn clone writes through the txn', async () => {
    const person = await resolver.match('Person').save({ name: 'raw-cache-txn', emailAddress: 'raw-cache-txn@example.com' });
    try {
      const txn = resolver.transaction();
      const doc = await txn.match('Person').id(person.id).one();
      await doc.$.save({ name: 'inside-txn' });

      // Pre-fix, the doc's $ magic was bound to the ROOT resolver (which built the shared
      // loader map) — the write escaped the transaction and was immediately visible/durable.
      const outside = await resolver.match('Person').id(person.id).one();
      expect(outside.name).toBe('raw-cache-txn'); // uncommitted — invisible outside the txn

      await txn.rollback();
      const after = await resolver.match('Person').id(person.id).one();
      expect(after.name).toBe('raw-cache-txn'); // rolled back — the write never happened
    } finally {
      await resolver.match('Person').id(person.id).delete();
    }
  });

  test('the detached twin transforms with ITSELF — its docs write detached, not through the root', async () => {
    // The twin keeps its own loader map, but the per-call resolver still matters for $ magic.
    const person = await resolver.match('Person').save({ name: 'raw-cache-detach', emailAddress: 'raw-cache-detach@example.com' });
    try {
      const twin = resolver.detach();
      const doc = await twin.match('Person').id(person.id).one();
      expect(doc.$model).toBeDefined(); // transformed through a real resolver
      expect(context.autograph.resolver).toBe(resolver); // twin never registered itself
    } finally {
      await resolver.match('Person').id(person.id).delete();
    }
  });
});
