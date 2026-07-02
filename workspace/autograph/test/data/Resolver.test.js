const Emitter = require('../../src/data/Emitter');
const Resolver = require('../../src/data/Resolver');
const { PostOperationError } = require('../../src/service/ErrorService');

describe('Resolver (transaction regressions)', () => {
  let resolver;
  let context;
  let mongoClient;

  beforeAll(() => {
    ({ resolver, context, mongoClient } = global);
  });

  describe('resolve() propagates synchronous transform throws as rejections (regression)', () => {
    // Bug: dropping `async` from resolve() also dropped the implicit try/catch an async function
    // wraps its body in. #createSystemEvent's $query.transform(false) runs synchronously and can
    // throw synchronously (a transformer misbehaving, or — as reproduced here — simply broken).
    // Without `async`, that became a thrown exception out of resolve()/`.save()` instead of a
    // rejected promise, unlike every other error path in the framework.
    test('a transformer that throws synchronously during transform() rejects the returned promise, it does not throw synchronously', async () => {
      const model = resolver.getSchema().models.Person;
      const original = model.transformers.create.transform;
      model.transformers.create.transform = () => { throw new Error('boom-sync'); };

      let threwSynchronously = false;
      let pending;
      try {
        pending = resolver.match('Person').save({ name: 'sync-throw-test', emailAddress: 'sync-throw-test@example.com' });
      } catch {
        threwSynchronously = true;
      } finally {
        model.transformers.create.transform = original;
      }

      expect(threwSynchronously).toBe(false);
      await expect(pending).rejects.toThrow('boom-sync');
    });
  });

  describe('context.autograph.resolver is not stolen by internal *Many/RI auto-wrap clones (regression)', () => {
    // Bug: Resolver's constructor unconditionally re-registered itself onto
    // context[namespace].resolver. Since the internal auto-wrap clones the resolver
    // (.withTransaction -> .transaction({isolated:true}) -> .clone()) for every *Many/RI
    // operation, every one of those clones was ALSO running that registration — silently and
    // PERMANENTLY repointing context.autograph.resolver at an orphaned, empty-cache clone whose
    // transaction had already committed, for the rest of the request. Fixed with a `register`
    // constructor flag that clone() sets to false.
    test('an updateMany (auto-wrapped) does not change context.autograph.resolver', async () => {
      const before = context.autograph.resolver;
      expect(before).toBe(resolver);

      await resolver.match('Color').where({}).save({ type: 'blue' });

      expect(context.autograph.resolver).toBe(before);
    });

    test('a createMany (auto-wrapped) does not change context.autograph.resolver', async () => {
      const before = context.autograph.resolver;

      await resolver.match('Color').save([{ type: 'red' }, { type: 'green' }]);

      expect(context.autograph.resolver).toBe(before);
    });

    test('a delete that triggers an RI cascade does not change context.autograph.resolver', async () => {
      const author = await resolver.match('Person').save({ name: 'ctx-check-author', emailAddress: 'ctx-check-author@example.com' });
      const before = context.autograph.resolver;

      await resolver.match('Person').id(author.id).delete();

      expect(context.autograph.resolver).toBe(before);
    });

    test('clone() itself never touches context.autograph.resolver', () => {
      const before = context.autograph.resolver;
      resolver.clone();
      expect(context.autograph.resolver).toBe(before);
    });
  });

  describe('deleteOne only opens a transaction when the model actually has RI rules to protect', () => {
    // A model with no @field(onDelete:) rules pointing at it deletes exactly one document,
    // already atomic on its own — paying for a transaction buys nothing. Verified by spying on
    // the driver's own transaction() method, which is only ever called to actually open a session.
    test('deleting a Color (no incoming onDelete rules) never opens a transaction', async () => {
      const spy = jest.spyOn(mongoClient, 'transaction');
      const color = await resolver.match('Color').save({ type: 'purple' });

      await resolver.match('Color').id(color.id).delete();

      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    test('deleting a Person (has an incoming onDelete: cascade rule via friends) does open a transaction', async () => {
      const spy = jest.spyOn(mongoClient, 'transaction');
      const person = await resolver.match('Person').save({ name: 'ri-wrap-check', emailAddress: 'ri-wrap-check@example.com' });

      await resolver.match('Person').id(person.id).delete();

      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  describe('RI cascade atomicity: a later restrict failure rolls back an earlier cascade step', () => {
    // Person.friends is onDelete:cascade (self-referential pull); Book.author is onDelete:cascade;
    // Chapter.book is onDelete:restrict. Deleting a Person who (a) is listed in another Person's
    // friends array AND (b) authored a Book that has a Chapter must fail on the Chapter restrict —
    // and the friends-array pull from step (a), which runs earlier in the RI walk, must not stick.
    test('deleting an author whose book has a chapter rejects and leaves the friends-cascade untouched', async () => {
      const author = await resolver.match('Person').save({ name: 'atomic-author', emailAddress: 'atomic-author@example.com' });
      const friend = await resolver.match('Person').save({ name: 'atomic-friend', emailAddress: 'atomic-friend@example.com', friends: [author.id] });
      const book = await resolver.match('Book').save({ name: 'Atomic Book', price: 9.99, author: author.id });
      const chapter = await resolver.match('Chapter').save({ name: 'Atomic Chapter', book: book.id });

      await expect(resolver.match('Person').id(author.id).delete()).rejects.toThrow(/restrict/gi);

      // Nothing the cascade touched actually stuck — the whole delete is one atomic unit.
      expect(await resolver.match('Person').id(author.id).one()).not.toBeNull();
      expect(await resolver.match('Book').id(book.id).one()).not.toBeNull();
      const friendAfter = await resolver.match('Person').id(friend.id).one();
      expect(friendAfter.friends.map(f => `${f}`)).toContain(`${author.id}`);

      // Cleanup so later tests in this file see a clean slate.
      await resolver.match('Chapter').id(chapter.id).delete();
      await resolver.match('Book').id(book.id).delete();
      await resolver.match('Person').id(friend.id).delete();
      await resolver.match('Person').id(author.id).delete();
    });
  });

  describe('manual transaction() / withTransaction() — public API sanity + read-your-own-writes', () => {
    test('a manual transaction is isolated by default: uncommitted writes are invisible outside it, committed writes are visible after', async () => {
      const txn = resolver.transaction();
      const created = await txn.match('Person').save({ name: 'manual-txn-commit', emailAddress: 'manual-txn-commit@example.com' });

      expect(await resolver.match('Person').id(created.id).one()).toBeNull();
      await txn.commit();
      expect(await resolver.match('Person').id(created.id).one()).not.toBeNull();

      await resolver.match('Person').id(created.id).delete();
    });

    test('a rolled-back manual transaction leaves no trace', async () => {
      const txn = resolver.transaction();
      const created = await txn.match('Person').save({ name: 'manual-txn-rollback', emailAddress: 'manual-txn-rollback@example.com' });
      await txn.rollback();

      expect(await resolver.match('Person').id(created.id).one()).toBeNull();
    });

    test('reads through the SAME transactional resolver see its own uncommitted writes (read-your-own-writes)', async () => {
      const txn = resolver.transaction();
      const created = await txn.match('Person').save({ name: 'read-your-writes', emailAddress: 'read-your-writes@example.com' });

      expect(await txn.match('Person').id(created.id).one()).not.toBeNull();
      expect(await resolver.match('Person').id(created.id).one()).toBeNull(); // outside — still invisible

      await txn.rollback();
    });

    // A transaction() call binds a session on its first operation — read or write — not just its
    // first write (see TransactionScope#eager). Before this, a transaction that only reads never
    // bound any session at all, so it had no real snapshot: its "isolation" was an accident of a
    // DataLoader cache nothing else could reach, not a real guarantee. This asserts the real one.
    test('a read-only manual transaction keeps a consistent snapshot even after another transaction commits in the meantime', async () => {
      const txn1 = resolver.transaction();
      const txn2 = resolver.transaction(); // never writes — binds its session on the read below

      const created = await txn1.match('Person').save({ name: 'snapshot-read-only', emailAddress: 'snapshot-read-only@example.com' });
      expect(await txn2.match('Person').id(created.id).one()).toBeNull(); // txn2's snapshot starts here — before txn1 commits

      await txn1.commit();

      // txn2's snapshot was fixed before the commit — it must still not see it.
      expect(await txn2.match('Person').id(created.id).one()).toBeNull();
      expect(await resolver.match('Person').id(created.id).one()).not.toBeNull(); // outside — sees the commit

      await txn2.rollback();
      await resolver.match('Person').id(created.id).delete();
    });

    test('withTransaction commits on success and returns the callback\'s result', async () => {
      const result = await resolver.withTransaction(async (txn) => {
        return txn.match('Person').save({ name: 'with-txn-commit', emailAddress: 'with-txn-commit@example.com' });
      });

      expect(result.name).toBe('with-txn-commit');
      expect(await resolver.match('Person').id(result.id).one()).not.toBeNull();

      await resolver.match('Person').id(result.id).delete();
    });

    test('withTransaction rolls back and rethrows on failure', async () => {
      let createdId;

      await expect(resolver.withTransaction(async (txn) => {
        const created = await txn.match('Person').save({ name: 'with-txn-rollback', emailAddress: 'with-txn-rollback@example.com' });
        createdId = created.id;
        throw new Error('deliberate failure');
      })).rejects.toThrow('deliberate failure');

      expect(await resolver.match('Person').id(createdId).one()).toBeNull();
    });
  });

  describe('isolated transactions share DataLoaders with the resolver they were cloned from', () => {
    // DataLoaders are a per-request cache, not a per-transaction one. clone() (used by every
    // isolated transaction — manual or the internal *Many/RI auto-wrap) shares them by reference
    // rather than rebuilding fresh ones, both for performance (no cold cache misses on data the
    // calling resolver already fetched) and correctness: a resolver that already cached a doc must
    // not keep returning that stale copy after an isolated transaction commits a change to it.
    // Read visibility itself is governed entirely by which DB session a query uses (see
    // TransactionScope#peekSession), not by which DataLoader instance served it — sharing the cache
    // doesn't change what's visible when, only whether a request has to re-fetch to see it.
    test('the resolver a transaction was cloned from does not see stale cached data after the transaction commits a change', async () => {
      const person = await resolver.match('Person').save({ name: 'cache-share-check', emailAddress: 'cache-share-check@example.com' });

      // Prime the calling resolver's own DataLoader cache for this doc.
      const primed = await resolver.match('Person').id(person.id).one();
      expect(primed.age).toBeUndefined();

      const txn = resolver.transaction();
      await txn.match('Person').id(person.id).save({ age: 42 });
      await txn.commit();

      const afterCommit = await resolver.match('Person').id(person.id).one();
      expect(afterCommit.age).toBe(42); // not the stale, primed copy

      await resolver.match('Person').id(person.id).delete();
    });

    test('an internal *Many auto-wrap clone also invalidates the calling resolver\'s cache immediately', async () => {
      const color = await resolver.match('Color').save({ type: 'blue' });

      // Prime the calling resolver's cache with this EXACT query shape (same cache key).
      const primed = await resolver.match('Color').id(color.id).one();
      expect(primed.isDefault).toBeFalsy();

      // updateMany auto-wraps internally via an isolated clone (see QueryResolver#withTransaction)
      await resolver.match('Color').where({ id: color.id }).save({ isDefault: true });

      const afterUpdate = await resolver.match('Color').id(color.id).one();
      expect(afterUpdate.isDefault).toBe(true); // not the stale, primed copy

      await resolver.match('Color').id(color.id).delete();
    });
  });

  describe('enableAutoTransaction() — retroactive "operation mode"', () => {
    // Each test builds its own resolver (register: false, so it never hijacks
    // context.autograph.resolver) rather than mutating the shared `global.resolver` — enabling
    // autoTransaction on the shared instance would leak an unresolved transaction into every
    // later test in this file, since nothing else would ever call .commit()/.rollback() on it.
    const freshResolver = () => new Resolver({ schema: resolver.getSchema(), context, register: false });

    test('is a no-op if the resolver already has a scope (from the constructor)', () => {
      const withAuto = new Resolver({ schema: resolver.getSchema(), context, register: false, autoTransaction: true });
      const original = withAuto.transactionScope;
      expect(withAuto.enableAutoTransaction()).toBe(withAuto); // returns this, for chaining
      expect(withAuto.transactionScope).toBe(original); // same scope object, not replaced
    });

    test('is idempotent — calling it twice does not discard an already-bound session', async () => {
      const txnResolver = freshResolver();
      txnResolver.enableAutoTransaction();
      const created = await txnResolver.match('Person').save({ name: 'op-mode-idempotent', emailAddress: 'op-mode-idempotent@example.com' });
      const scopeAfterFirstWrite = txnResolver.transactionScope;

      txnResolver.enableAutoTransaction(); // second call — must not reset anything
      expect(txnResolver.transactionScope).toBe(scopeAfterFirstWrite);
      expect(await txnResolver.match('Person').id(created.id).one()).not.toBeNull(); // still sees its own write

      await txnResolver.rollback();
    });

    // The scenario that motivated this: a GraphQL operation with multiple top-level mutation
    // fields (fully spec-sequential) whose caller wants all-or-nothing semantics across them,
    // without the host having decided autoTransaction: true for every request up front. A host
    // integration would call this from something like Apollo's didResolveOperation — which runs
    // after the operation is parsed/validated but before any resolver dispatches — once it's
    // determined the operation's shape warrants it (e.g. more than one top-level mutation field).
    test('makes two otherwise-independent sequential mutations atomic together', async () => {
      const txnResolver = freshResolver();
      txnResolver.enableAutoTransaction();

      // Field "a" of the operation.
      const first = await txnResolver.match('Person').save({ name: 'op-mode-batch', emailAddress: 'op-mode-batch-a@example.com' });

      // Field "b" of the operation — fails (duplicate name, unique index).
      await expect(
        txnResolver.match('Person').save({ name: 'op-mode-batch', emailAddress: 'op-mode-batch-b@example.com' }),
      ).rejects.toThrow(/duplicate/gi);

      // Host's error path (e.g. Apollo's didEncounterErrors -> resolver.rollback()).
      await txnResolver.rollback();

      // Field "a"'s write must NOT have stuck either — that's the whole point of operation mode.
      expect(await resolver.match('Person').id(first.id).one()).toBeNull();
    });

    test('commits both fields together when the whole operation succeeds', async () => {
      const txnResolver = freshResolver();
      txnResolver.enableAutoTransaction();

      const a = await txnResolver.match('Person').save({ name: 'op-mode-success-a', emailAddress: 'op-mode-success-a@example.com' });
      const b = await txnResolver.match('Person').save({ name: 'op-mode-success-b', emailAddress: 'op-mode-success-b@example.com' });
      await txnResolver.commit();

      expect(await resolver.match('Person').id(a.id).one()).not.toBeNull();
      expect(await resolver.match('Person').id(b.id).one()).not.toBeNull();

      await resolver.match('Person').id(a.id).delete();
      await resolver.match('Person').id(b.id).delete();
    });

    test('calling it late does not retroactively cover a write that already ran non-transactionally', async () => {
      const txnResolver = freshResolver();

      const before = await txnResolver.match('Person').save({ name: 'op-mode-too-late', emailAddress: 'op-mode-too-late@example.com' });
      txnResolver.enableAutoTransaction(); // enabled AFTER the first write already committed on its own

      const after = await txnResolver.match('Person').save({ name: 'op-mode-too-late-2', emailAddress: 'op-mode-too-late-2@example.com' });
      await txnResolver.rollback(); // only covers `after`

      expect(await resolver.match('Person').id(before.id).one()).not.toBeNull(); // unaffected — already committed
      expect(await resolver.match('Person').id(after.id).one()).toBeNull(); // rolled back

      await resolver.match('Person').id(before.id).delete();
    });
  });

  describe('PostOperationError — post-write hook failures never roll back an already-successful write (regression)', () => {
    // Bug: postMutation/preResponse/postResponse rejections propagated through the exact same
    // path as preMutation/write failures, so a side-effect hook (logging, notifications, etc)
    // throwing could both (a) report the mutation as failed to the caller even though the write
    // had already durably succeeded, and (b) inside a *Many/RI auto-wrap, roll back OTHER,
    // unrelated elements that had nothing wrong with them. Fixed: Resolver#createSystemEvent wraps
    // post-phase failures in PostOperationError; Resolver#withTransaction commits (not rolls back)
    // on that specific type, still re-throwing it to the caller.
    // Color has only 4 possible `type` values and other tests in this file create/leave some of
    // them behind — filtering reads by type would pick up unrelated documents. Track exact
    // doc IDs (or a before/after count of the WHOLE collection) instead of filtering by type.
    test('a single mutation: the caller still sees the error, but the write is NOT undone', async () => {
      const hook = async (event, next) => {
        if (event.query.model === 'Color') throw new Error('side-effect failure');
        next();
      };
      Emitter.onModels('postMutation', ['Color'], hook);

      let caughtError;
      try {
        await resolver.match('Color').save({ type: 'blue' });
      } catch (e) {
        caughtError = e;
      }
      Emitter.removeListener('postMutation', hook);

      expect(caughtError).toBeInstanceOf(PostOperationError);
      expect(caughtError.data.message).toBe('side-effect failure');
      expect(caughtError.result).toBeDefined(); // what was actually written, despite the error

      const written = await resolver.match('Color').id(caughtError.result.id).one();
      expect(written).not.toBeNull(); // the write stuck
      await resolver.match('Color').id(caughtError.result.id).delete();
    });

    test('createMany: one element\'s postMutation failure does not roll back a different, successful element', async () => {
      const before = await resolver.match('Color').where({}).many();

      let callCount = 0;
      const hook = async (event, next) => {
        callCount += 1;
        if (callCount === 2) throw new Error('side-effect failure on second element');
        next();
      };
      Emitter.onModels('postMutation', ['Color'], hook);

      let caughtError;
      try {
        await resolver.match('Color').save([{ type: 'red' }, { type: 'green' }]);
      } catch (e) {
        caughtError = e;
      }
      Emitter.removeListener('postMutation', hook);

      expect(caughtError).toBeInstanceOf(PostOperationError);

      const after = await resolver.match('Color').where({}).many();
      expect(after.length).toBe(before.length + 2); // BOTH elements persisted — this is the fix

      const beforeIds = new Set(before.map(b => `${b.id}`));
      const added = after.filter(a => !beforeIds.has(`${a.id}`));
      await Promise.all(added.map(a => resolver.match('Color').id(a.id).delete()));
    });

    test('createMany: a genuine failure on one element still rolls back everything, even when a different element also has a postMutation-only failure', async () => {
      // Regression for the mixed-failure race: Promise.all would only ever surface whichever
      // element's rejection happened to settle first. A preMutation failure is structurally always
      // faster than a postMutation failure (the latter can't even start until its own write has
      // completed) — so pairing "a preMutation failure" with "a postMutation failure" would pass
      // even with plain Promise.all, by accident, proving nothing about the actual race. To force
      // the real failure to be the SLOWER one (the only way Promise.all's "first wins" could
      // plausibly pick the wrong one), this uses a genuine write-level failure (a duplicate name
      // against Person's unique index) deliberately delayed via an artificial sleep in its own
      // preMutation hook, racing against a different element's postMutation failure, which fires
      // fast (immediately after its own successful write, no delay).
      const before = await resolver.match('Person').where({}).many();
      const existing = await resolver.match('Person').save({ name: 'race-real-failure', emailAddress: 'race-real-failure-0@example.com' });

      const delayHook = async (event, next) => {
        if (event.query.input?.name === 'race-real-failure') await new Promise((r) => { setTimeout(r, 50); });
        next();
      };
      const postHook = async (event, next) => {
        if (event.query.input?.name === 'race-post-failure') throw new Error('side-effect failure (must not mask the real one)');
        next();
      };
      Emitter.onModels('preMutation', ['Person'], delayHook);
      Emitter.onModels('postMutation', ['Person'], postHook);

      let caughtError;
      try {
        await resolver.match('Person').save([
          { name: 'race-real-failure', emailAddress: 'race-real-failure-1@example.com' }, // duplicate name -> real DB failure, delayed
          { name: 'race-post-failure', emailAddress: 'race-post-failure@example.com' }, // succeeds its write, fails its post hook, fast
        ]);
      } catch (e) {
        caughtError = e;
      }
      Emitter.removeListener('preMutation', delayHook);
      Emitter.removeListener('postMutation', postHook);

      expect(caughtError).not.toBeInstanceOf(PostOperationError); // the real (duplicate-key) failure wins, not masked

      const after = await resolver.match('Person').where({}).many();
      expect(after.length).toBe(before.length + 1); // only `existing` — the whole batch rolled back

      await resolver.match('Person').id(existing.id).delete();
    });

    test('RI cascade: a postMutation failure on an early cascade step does not stop later steps, and the whole cascade still commits', async () => {
      const author = await resolver.match('Person').save({ name: 'ri-post-author', emailAddress: 'ri-post-author@example.com' });
      const friend = await resolver.match('Person').save({ name: 'ri-post-friend', emailAddress: 'ri-post-friend@example.com', friends: [author.id] });
      const book = await resolver.match('Book').save({ name: 'RI Post Book', price: 9.99, author: author.id });

      // Fires for the friends-cascade step (an update on Person) — fails AFTER that write succeeds.
      const hook = async (event, next) => {
        if (event.query.model === 'Person' && event.query.crud === 'update') throw new Error('side-effect failure on cascade step');
        next();
      };
      Emitter.onModels('postMutation', ['Person'], hook);

      let caughtError;
      try {
        await resolver.match('Person').id(author.id).delete();
      } catch (e) {
        caughtError = e;
      }
      Emitter.removeListener('postMutation', hook);

      expect(caughtError).toBeInstanceOf(PostOperationError);

      // The friends-cascade step's write actually took effect...
      const friendAfter = await resolver.match('Person').id(friend.id).one();
      expect(friendAfter.friends.map(f => `${f}`)).not.toContain(`${author.id}`);

      // ...AND the walk continued past it: the book cascade (a later step) also completed...
      expect(await resolver.match('Book').id(book.id).one()).toBeNull();

      // ...AND the final delete itself committed.
      expect(await resolver.match('Person').id(author.id).one()).toBeNull();

      await resolver.match('Person').id(friend.id).delete();
    });
  });
});
