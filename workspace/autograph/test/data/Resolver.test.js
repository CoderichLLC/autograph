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
    // first write. Before this, a transaction that only reads never
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

  describe('settled transactions — post-settle reads degrade gracefully, post-settle writes fail loudly', () => {
    // Docs returned from a transaction lazily resolve populated fields through the SAME (cloned,
    // now-settled) resolver during response serialization — after commit() sealed the session. A
    // read at that point must degrade to a plain, sessionless read of committed state, not error.
    // A WRITE against a settled scope is a genuine caller bug and must reject with a clear
    // AG-level error instead of a raw driver "session ended" one.
    test('a read through a committed transaction resolver still works — sessionless, sees committed state', async () => {
      const txn = resolver.transaction();
      const created = await txn.match('Person').save({ name: 'post-settle-read', emailAddress: 'post-settle-read@example.com' });
      await txn.commit();

      const after = await txn.match('Person').id(created.id).one();
      expect(after).not.toBeNull();
      expect(after.name).toBe('post-settle-read');

      await resolver.match('Person').id(created.id).delete();
    });

    test('a write through a committed transaction resolver rejects with a clear AG-level error', async () => {
      const txn = resolver.transaction();
      const created = await txn.match('Person').save({ name: 'post-settle-write', emailAddress: 'post-settle-write@example.com' });
      await txn.commit();

      await expect(
        txn.match('Person').save({ name: 'post-settle-write-2', emailAddress: 'post-settle-write-2@example.com' }),
      ).rejects.toThrow(/already committed/);

      await resolver.match('Person').id(created.id).delete();
    });

    test('commit()/rollback() are idempotent at the resolver level', async () => {
      const txn = resolver.transaction();
      const created = await txn.match('Person').save({ name: 'idempotent-settle', emailAddress: 'idempotent-settle@example.com' });

      await txn.commit();
      await expect(txn.commit()).resolves.toBeUndefined();
      await expect(txn.rollback()).resolves.toBeUndefined(); // fate already sealed — must NOT undo the commit

      expect(await resolver.match('Person').id(created.id).one()).not.toBeNull();
      await resolver.match('Person').id(created.id).delete();
    });

    test('transaction({ isolated: false }) refuses to orphan an active scope', async () => {
      const txn = resolver.transaction();
      expect(() => txn.transaction({ isolated: false })).toThrow(/orphan/);
      await txn.rollback();

      // ...but is fine once the scope has settled — a settled scope is no longer "ambient".
      expect(() => txn.transaction({ isolated: false })).not.toThrow();
      await txn.rollback(); // settle the replacement scope so nothing leaks
    });
  });

  describe('isolated transactions share DataLoaders with the resolver they were cloned from', () => {
    // DataLoaders are a per-request cache, not a per-transaction one. clone() (used by every
    // isolated transaction — manual or the internal *Many/RI auto-wrap) shares them by reference
    // rather than rebuilding fresh ones, both for performance (no cold cache misses on data the
    // calling resolver already fetched) and correctness: a resolver that already cached a doc must
    // not keep returning that stale copy after an isolated transaction commits a change to it.
    // Read visibility itself is governed entirely by which DB session a query uses (see
    // TransactionScope#getSession), not by which DataLoader instance served it — sharing the cache
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

  describe('transaction({ isolated: false }) — the host escape hatch (in-place whole-request scope)', () => {
    // A host that assembles its own executable schema (bypassing Schema#toObject's operation-
    // scope wrap) scopes the whole request in place this way and owns commit()/rollback() at its
    // own completion point (§4.7). The rollback side of that integration is covered end-to-end
    // by OperationScope.test.js's host-managed test. Each test here builds its own resolver
    // (register: false, so it never hijacks context.autograph.resolver) rather than mutating the
    // shared `global.resolver` — an in-place scope on the shared instance would leak an
    // unresolved transaction into every later test in this file.
    const freshResolver = () => new Resolver({ schema: resolver.getSchema(), context, register: false });

    test('commits multiple writes together when the host commits the request', async () => {
      const txnResolver = freshResolver().transaction({ isolated: false });
      expect(txnResolver).toBeInstanceOf(Resolver); // returns this, for chaining

      const a = await txnResolver.match('Person').save({ name: 'host-hatch-a', emailAddress: 'host-hatch-a@example.com' });
      const b = await txnResolver.match('Person').save({ name: 'host-hatch-b', emailAddress: 'host-hatch-b@example.com' });
      await txnResolver.commit();

      expect(await resolver.match('Person').id(a.id).one()).not.toBeNull();
      expect(await resolver.match('Person').id(b.id).one()).not.toBeNull();

      await resolver.match('Person').id(a.id).delete();
      await resolver.match('Person').id(b.id).delete();
    });

    test('scoping in place late does not retroactively cover a write that already ran non-transactionally', async () => {
      const txnResolver = freshResolver();

      const before = await txnResolver.match('Person').save({ name: 'host-hatch-late', emailAddress: 'host-hatch-late@example.com' });
      txnResolver.transaction({ isolated: false }); // scoped AFTER the first write already committed on its own

      const after = await txnResolver.match('Person').save({ name: 'host-hatch-late-2', emailAddress: 'host-hatch-late-2@example.com' });
      await txnResolver.rollback(); // only covers `after`

      expect(await resolver.match('Person').id(before.id).one()).not.toBeNull(); // unaffected — already committed
      expect(await resolver.match('Person').id(after.id).one()).toBeNull(); // rolled back

      await resolver.match('Person').id(before.id).delete();
    });
  });

  describe('postCommit / postRollback — the durable-outcome events', () => {
    // postCommit = "this write is durable": the transaction it rode in truly committed, or no
    // transaction carried it and it was durable the moment the driver returned. postRollback =
    // "this write was undone" (compensation). Both fire AFTER the full postMutation/preResponse/
    // postResponse chain — they are fire-and-forget outcome announcements, not lifecycle stages;
    // they cannot shape the response and their failures are isolated.
    let events;
    const track = name => (event) => { events.push({ name, model: event.query.model, result: event.query.result }); };
    let onCommit;
    let onRollback;

    beforeEach(() => {
      events = [];
      onCommit = track('postCommit');
      onRollback = track('postRollback');
      Emitter.onModels('postCommit', ['Person', 'Color'], onCommit);
      Emitter.onModels('postRollback', ['Person', 'Color'], onRollback);
    });

    afterEach(() => {
      Emitter.removeListener('postCommit', onCommit);
      Emitter.removeListener('postRollback', onRollback);
    });

    test('a non-transactional write emits postCommit immediately after its lifecycle — and after postMutation', async () => {
      const order = [];
      const postMutationHook = async (event, next) => { order.push('postMutation'); next(); };
      const commitHook = () => { order.push('postCommit'); };
      Emitter.onModels('postMutation', ['Color'], postMutationHook);
      Emitter.onModels('postCommit', ['Color'], commitHook);

      const color = await resolver.match('Color').save({ type: 'red' });

      Emitter.removeListener('postMutation', postMutationHook);
      Emitter.removeListener('postCommit', commitHook);

      expect(order).toEqual(['postMutation', 'postCommit']);
      expect(events).toEqual([{ name: 'postCommit', model: 'Color', result: expect.objectContaining({ id: color.id }) }]);

      await resolver.match('Color').id(color.id).delete();
    });

    test('a manual transaction defers postCommit until the transaction truly commits', async () => {
      const txn = resolver.transaction();
      const created = await txn.match('Person').save({ name: 'post-commit-defer', emailAddress: 'post-commit-defer@example.com' });

      expect(events).toEqual([]); // written, not yet durable — nothing announced

      await txn.commit();
      expect(events).toEqual([{ name: 'postCommit', model: 'Person', result: expect.objectContaining({ id: created.id }) }]);

      await resolver.match('Person').id(created.id).delete();
      events = []; // ignore the delete's own events
    });

    test('a rolled-back transaction emits postRollback (compensation), never postCommit', async () => {
      const txn = resolver.transaction();
      await txn.match('Person').save({ name: 'post-rollback', emailAddress: 'post-rollback@example.com' });
      await txn.rollback();

      expect(events).toEqual([{ name: 'postRollback', model: 'Person', result: expect.anything() }]);
    });

    test('a *Many batch emits one postCommit per element, at the batch\'s own commit', async () => {
      await resolver.match('Color').save([{ type: 'green' }, { type: 'purple' }]);

      const commits = events.filter(e => e.name === 'postCommit');
      expect(commits).toHaveLength(2);
      commits.forEach(e => expect(e.result.id).toBeDefined());

      await Promise.all(commits.map(e => resolver.match('Color').id(e.result.id).delete()));
    });

    test('postCommit still fires when only a post-write hook failed — the write itself is durable', async () => {
      const failingHook = async (event, next) => { throw new Error('side-effect failure'); };
      Emitter.onModels('postMutation', ['Color'], failingHook);

      let caughtError;
      try {
        await resolver.match('Color').save({ type: 'purple' });
      } catch (e) {
        caughtError = e;
      }
      Emitter.removeListener('postMutation', failingHook);

      expect(caughtError).toBeInstanceOf(PostOperationError);
      expect(events).toEqual([{ name: 'postCommit', model: 'Color', result: expect.anything() }]);

      await resolver.match('Color').id(events[0].result.id).delete();
    });

    test('a failed write emits neither — there is no durable outcome to announce', async () => {
      await expect(resolver.match('Person').save({ name: 'no-email' })).rejects.toThrow(); // required emailAddress
      expect(events).toEqual([]);
    });

    test('a preMutation short-circuit emits neither — nothing was written', async () => {
      const shortCircuit = () => ({ id: 'synthetic', type: 'blue' });
      Emitter.onModels('preMutation', ['Color'], shortCircuit);

      const result = await resolver.match('Color').save({ type: 'blue' });
      Emitter.removeListener('preMutation', shortCircuit);

      expect(result.id).toBe('synthetic'); // the short-circuit value, no write
      expect(events).toEqual([]);
    });
  });

  describe('postResponse — unconditional, pure response observer', () => {
    // postResponse observes the final, out-the-door result (the response layer). It ALWAYS fires,
    // last, with the settled result — including when postMutation or preResponse overrode it via
    // the return-value idiom (previously those short-circuits silenced it, so the observer missed
    // exactly the responses that were reshaped). As a PURE observer its return value is ignored.
    let observed;
    let observer;

    beforeEach(() => {
      observed = [];
      // postResponse fires for reads too — record mutations only, so this suite's own
      // setup/cleanup reads don't pollute the assertions.
      observer = (event) => { if (event.query.isMutation) observed.push(event.query.result); };
      Emitter.onModels('postResponse', ['Color'], observer);
    });

    afterEach(() => {
      Emitter.removeListener('postResponse', observer);
    });

    // Both override tests reshape only the RESPONSE — the underlying write still lands a real
    // row, so cleanup diffs the whole collection before/after rather than trusting the result.
    const collectIds = rows => new Set(rows.map(r => `${r.id}`));

    test('fires even when postMutation short-circuits with a replacement result — and sees that replacement', async () => {
      const before = await resolver.match('Color').where({}).many();
      const override = { id: 'pm-override', type: 'blue' };
      const hook = () => override;
      Emitter.onModels('postMutation', ['Color'], hook);

      const result = await resolver.match('Color').save({ type: 'blue' });
      Emitter.removeListener('postMutation', hook);

      expect(result).toBe(override);
      expect(observed).toEqual([override]); // observer saw the FINAL (overridden) result

      const beforeIds = collectIds(before);
      const added = (await resolver.match('Color').where({}).many()).filter(r => !beforeIds.has(`${r.id}`));
      await Promise.all(added.map(r => resolver.match('Color').id(r.id).delete()));
    });

    test('fires even when preResponse overrides the result — and sees preResponse\'s value', async () => {
      const before = await resolver.match('Color').where({}).many();
      const override = { id: 'pr-override', type: 'red' };
      const hook = () => override;
      Emitter.onModels('preResponse', ['Color'], hook);

      const result = await resolver.match('Color').save({ type: 'red' });
      Emitter.removeListener('preResponse', hook);

      expect(result).toBe(override);
      expect(observed).toEqual([override]);

      const beforeIds = collectIds(before);
      const added = (await resolver.match('Color').where({}).many()).filter(r => !beforeIds.has(`${r.id}`));
      await Promise.all(added.map(r => resolver.match('Color').id(r.id).delete()));
    });

    test('its return value is ignored — a pure observer cannot reshape the response', async () => {
      const hijacker = event => ({ id: 'hijacked', type: 'green' }); // returned value must NOT become the result
      Emitter.onModels('postResponse', ['Color'], hijacker);

      const result = await resolver.match('Color').save({ type: 'green' });
      Emitter.removeListener('postResponse', hijacker);

      expect(result.id).toBeDefined();
      expect(result.id).not.toBe('hijacked');
      expect(result.type).toBe('green');

      await resolver.match('Color').id(result.id).delete();
    });

    test('a postResponse throw is a response-layer failure — PostOperationError, the write stays', async () => {
      const thrower = (event, next) => { throw new Error('observer exploded'); };
      Emitter.onModels('postResponse', ['Color'], thrower);

      let caughtError;
      try {
        await resolver.match('Color').save({ type: 'purple' });
      } catch (e) {
        caughtError = e;
      }
      Emitter.removeListener('postResponse', thrower);

      expect(caughtError).toBeInstanceOf(PostOperationError);
      expect(caughtError.result).toBeDefined();
      expect(await resolver.match('Color').id(caughtError.result.id).one()).not.toBeNull();

      await resolver.match('Color').id(caughtError.result.id).delete();
    });
  });

  describe('role-graded post-phase failures — participants abort, presenters surface, bare writes stay', () => {
    // The post* phase is role-graded (TRANSACTIONS.md §4.15):
    // - postMutation = PARTICIPANT: part of the unit of work (audit rows, counters, invariant
    //   checks). Its failure means the unit is INCOMPLETE — on a transaction-carried write it
    //   propagates unwrapped and aborts the whole unit, same as a write failure. Tolerance is
    //   opt-in (the hook's own try/catch); observers belong in postCommit.
    // - preResponse/postResponse = PRESENTER: the data is complete and correct, only the
    //   presentation failed — always PostOperationError, never rollback-worthy.
    // - A write NO transaction carried is already durable when its post-phase runs — any
    //   post-phase failure surfaces as PostOperationError with `.result` (honest fallback).
    // Color has only 4 possible `type` values and other tests in this file create/leave some of
    // them behind — filtering reads by type would pick up unrelated documents. Track exact
    // doc IDs (or a before/after count of the WHOLE collection) instead of filtering by type.
    test('a bare (non-transactional) mutation: the caller still sees the error, but the write is NOT undone', async () => {
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

    test('createMany: one element\'s postMutation (participant) failure aborts the WHOLE batch', async () => {
      const before = await resolver.match('Color').where({}).many();

      let callCount = 0;
      const hook = async (event, next) => {
        callCount += 1;
        if (callCount === 2) throw new Error('participant failure on second element');
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

      // A participant failure is a REAL failure — unwrapped, not a PostOperationError.
      expect(caughtError).toBeDefined();
      expect(caughtError).not.toBeInstanceOf(PostOperationError);

      const after = await resolver.match('Color').where({}).many();
      expect(after.length).toBe(before.length); // NOTHING persisted — the unit is incomplete without its participant
    });

    test('createMany: one element\'s preResponse (presenter) failure does NOT roll back the batch — data is complete', async () => {
      const before = await resolver.match('Color').where({}).many();

      let callCount = 0;
      const hook = async (event, next) => {
        callCount += 1;
        if (callCount === 2) throw new Error('presentation failure on second element');
        next();
      };
      Emitter.onModels('preResponse', ['Color'], hook);

      let caughtError;
      try {
        await resolver.match('Color').save([{ type: 'red' }, { type: 'green' }]);
      } catch (e) {
        caughtError = e;
      }
      Emitter.removeListener('preResponse', hook);

      expect(caughtError).toBeInstanceOf(PostOperationError);

      // The recovery payload is positionally complete: the element whose presenter hook failed
      // DID commit its write, so its written doc belongs in .result alongside the clean one.
      expect(caughtError.result).toHaveLength(2);
      caughtError.result.forEach(r => expect(r.id).toBeDefined());

      const after = await resolver.match('Color').where({}).many();
      expect(after.length).toBe(before.length + 2); // BOTH elements persisted

      const beforeIds = new Set(before.map(b => `${b.id}`));
      const added = after.filter(a => !beforeIds.has(`${a.id}`));
      await Promise.all(added.map(a => resolver.match('Color').id(a.id).delete()));
    });

    test('createMany: the same failure-prone hook as an OBSERVER (postCommit) can abort nothing — both elements persist', async () => {
      const before = await resolver.match('Color').where({}).many();

      const hook = async (event) => { throw new Error('observer failure — isolated, logged-only'); };
      Emitter.observeModels('postCommit', ['Color'], hook);

      const results = await resolver.match('Color').save([{ type: 'red' }, { type: 'green' }]); // resolves — no error surfaces
      Emitter.removeListener('postCommit', hook);

      expect(results).toHaveLength(2);
      const after = await resolver.match('Color').where({}).many();
      expect(after.length).toBe(before.length + 2);

      await Promise.all(results.map(r => resolver.match('Color').id(r.id).delete()));
    });

    test('createMany: a genuine failure on one element still rolls back everything, even when a different element also has a presenter-only failure', async () => {
      // Regression for the mixed-failure race: Promise.all would only ever surface whichever
      // element's rejection happened to settle first. A preMutation failure is structurally always
      // faster than a presenter failure (the latter can't even start until its own write has
      // completed) — so pairing "a preMutation failure" with "a presenter failure" would pass
      // even with plain Promise.all, by accident, proving nothing about the actual race. To force
      // the real failure to be the SLOWER one (the only way Promise.all's "first wins" could
      // plausibly pick the wrong one), this uses a genuine write-level failure (a duplicate name
      // against Person's unique index) deliberately delayed via an artificial sleep in its own
      // preMutation hook, racing against a different element's preResponse (presenter) failure,
      // which fires fast (immediately after its own successful write, no delay).
      const before = await resolver.match('Person').where({}).many();
      const existing = await resolver.match('Person').save({ name: 'race-real-failure', emailAddress: 'race-real-failure-0@example.com' });

      const delayHook = async (event, next) => {
        if (event.query.input?.name === 'race-real-failure') await new Promise((r) => { setTimeout(r, 50); });
        next();
      };
      const postHook = async (event, next) => {
        if (event.query.input?.name === 'race-post-failure') throw new Error('presenter failure (must not mask the real one)');
        next();
      };
      Emitter.onModels('preMutation', ['Person'], delayHook);
      Emitter.onModels('preResponse', ['Person'], postHook);

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
      Emitter.removeListener('preResponse', postHook);

      expect(caughtError).not.toBeInstanceOf(PostOperationError); // the real (duplicate-key) failure wins, not masked

      const after = await resolver.match('Person').where({}).many();
      expect(after.length).toBe(before.length + 1); // only `existing` — the whole batch rolled back

      await resolver.match('Person').id(existing.id).delete();
    });

    test('RI cascade: a presenter (preResponse) failure on an early cascade step does not stop later steps, and the whole cascade still commits', async () => {
      const author = await resolver.match('Person').save({ name: 'ri-post-author', emailAddress: 'ri-post-author@example.com' });
      const friend = await resolver.match('Person').save({ name: 'ri-post-friend', emailAddress: 'ri-post-friend@example.com', friends: [author.id] });
      const book = await resolver.match('Book').save({ name: 'RI Post Book', price: 9.99, author: author.id });

      // Fires for the friends-cascade step (an update on Person) — fails AFTER that write succeeds.
      const hook = async (event, next) => {
        if (event.query.model === 'Person' && event.query.crud === 'update') throw new Error('presenter failure on cascade step');
        next();
      };
      Emitter.onModels('preResponse', ['Person'], hook);

      let caughtError;
      try {
        await resolver.match('Person').id(author.id).delete();
      } catch (e) {
        caughtError = e;
      }
      Emitter.removeListener('preResponse', hook);

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

    test('RI cascade: a postMutation (participant) failure on a cascade step aborts the WHOLE delete', async () => {
      const author = await resolver.match('Person').save({ name: 'ri-abort-author', emailAddress: 'ri-abort-author@example.com' });
      const friend = await resolver.match('Person').save({ name: 'ri-abort-friend', emailAddress: 'ri-abort-friend@example.com', friends: [author.id] });
      const book = await resolver.match('Book').save({ name: 'RI Abort Book', price: 9.99, author: author.id });

      const hook = async (event, next) => {
        if (event.query.model === 'Person' && event.query.crud === 'update') throw new Error('participant failure on cascade step');
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

      expect(caughtError).toBeDefined();
      expect(caughtError).not.toBeInstanceOf(PostOperationError);

      // Nothing stuck — the cascade step's write, later steps, and the delete itself all rolled back.
      const friendAfter = await resolver.match('Person').id(friend.id).one();
      expect(friendAfter.friends.map(f => `${f}`)).toContain(`${author.id}`);
      expect(await resolver.match('Book').id(book.id).one()).not.toBeNull();
      expect(await resolver.match('Person').id(author.id).one()).not.toBeNull();

      // Cleanup (hook removed — cascades run clean now).
      await resolver.match('Book').id(book.id).delete();
      await resolver.match('Person').id(friend.id).delete();
      await resolver.match('Person').id(author.id).delete();
    });
  });

  describe('detached resolvers — OBSERVERS are never transaction participants', () => {
    // The unit of work is exactly what the mutation awaits. An OBSERVER (Emitter.observe*) is
    // never awaited, so it can never be a participant — the Emitter hands it a DETACHED resolver
    // (no scope, sessionless reads of committed state, writes land immediately and
    // fate-independently) instead of the ambient one. Participants (Emitter.on*) remain awaited
    // and still receive the ambient resolver.
    test('an OBSERVER receives a detached, scope-less resolver; a PARTICIPANT receives the ambient one', async () => {
      let basicResolver;
      let nextResolver;
      const basicHook = (event) => { basicResolver = event.resolver; };
      const nextHook = (event, next) => { nextResolver = event.resolver; next(); };
      Emitter.observeModels('postMutation', ['Person'], basicHook);
      Emitter.onModels('postMutation', ['Person'], nextHook);

      try {
        const txn = resolver.transaction();
        await txn.match('Person').save({ name: 'detach-identity', emailAddress: 'detach-identity@example.com' });

        expect(nextResolver).toBe(txn); // participant — shares the mutation's fate
        expect(basicResolver).not.toBe(txn); // observer — detached
        expect(basicResolver.transactionScope).toBeUndefined();
        expect(basicResolver).toBe(resolver.detach()); // one stable twin per request, clone-agnostic

        await txn.rollback();
      } finally {
        Emitter.removeListener('postMutation', basicHook);
        Emitter.removeListener('postMutation', nextHook);
      }
    });

    test('a detached write survives the carrying transaction\'s rollback (fate-independent by contract)', async () => {
      let pendingWrite;
      const hook = (event) => {
        pendingWrite = event.resolver.match('Color').save({ type: 'red' });
      };
      Emitter.observeModels('postMutation', ['Person'], hook);

      try {
        const txn = resolver.transaction();
        const person = await txn.match('Person').save({ name: 'detach-survives', emailAddress: 'detach-survives@example.com' });
        await txn.rollback();

        const color = await pendingWrite; // deterministic — never raced the settle for membership
        expect(await resolver.match('Person').id(person.id).one()).toBeNull(); // the mutation rolled back...
        expect(await resolver.match('Color').id(color.id).one()).not.toBeNull(); // ...the detached write did not

        await resolver.match('Color').id(color.id).delete();
      } finally {
        Emitter.removeListener('postMutation', hook);
      }
    });

    test('detached reads see committed state only — never the open transaction\'s uncommitted writes', async () => {
      let observed;
      const hook = (event) => {
        observed = event.resolver.match('Person').id(event.query.result.id).one();
      };
      Emitter.observeModels('postMutation', ['Person'], hook);

      try {
        const txn = resolver.transaction();
        await txn.match('Person').save({ name: 'detach-visibility', emailAddress: 'detach-visibility@example.com' });
        expect(await observed).toBeNull(); // sessionless — the txn hasn't committed
        await txn.rollback();
      } finally {
        Emitter.removeListener('postMutation', hook);
      }
    });

    test('writes through any resolver of the request invalidate the detached twin\'s (separate) cache', async () => {
      const detached = resolver.detach();
      const color = await resolver.match('Color').save({ type: 'blue' });

      // Prime the twin's own DataLoader cache with this exact query shape.
      const primed = await detached.match('Color').id(color.id).one();
      expect(primed.isDefault).toBeFalsy();

      await resolver.match('Color').id(color.id).save({ isDefault: true });

      const afterWrite = await detached.match('Color').id(color.id).one();
      expect(afterWrite.isDefault).toBe(true); // not the stale primed copy

      await resolver.match('Color').id(color.id).delete();
    });

    test('the detached twin can never acquire a scope in place — explicit units of work go through .transaction()', async () => {
      const detached = resolver.detach();
      expect(() => detached.transaction({ isolated: false })).toThrow(/detached/);
      expect(detached.detach()).toBe(detached); // its own twin — no twin-of-twin chains

      // The explicit path still works: .transaction() scopes a CLONE, never the twin itself.
      const txn = detached.transaction();
      expect(txn).not.toBe(detached);
      expect(detached.transactionScope).toBeUndefined();
      await txn.rollback();
    });

    test('a postCommit OBSERVER can write through event.resolver without a fresh transaction() incantation', async () => {
      // Previously documented gotcha: under a host-managed scope, a postCommit write through
      // event.resolver threw (its scope had settled). Detachment dissolves it for the
      // fire-and-forget form — the twin has no settled scope to trip over.
      let pendingWrite;
      const hook = (event) => {
        pendingWrite = event.resolver.match('Color').save({ type: 'green' });
      };
      Emitter.observeModels('postCommit', ['Person'], hook);

      let person;
      try {
        const txn = resolver.transaction();
        person = await txn.match('Person').save({ name: 'detach-postcommit', emailAddress: 'detach-postcommit@example.com' });
        await txn.commit();
      } finally {
        // BEFORE the cleanup deletes — the delete's own postCommit would re-fire the hook and
        // launch a stray fire-and-forget write racing the suite's afterAll disconnect.
        Emitter.removeListener('postCommit', hook);
      }

      const color = await pendingWrite;
      expect(await resolver.match('Color').id(color.id).one()).not.toBeNull();

      await resolver.match('Color').id(color.id).delete();
      await resolver.match('Person').id(person.id).delete();
    });
  });

  describe('event.context guards the transport resolver slot — hooks must use event.resolver', () => {
    // There is no legitimate hook-side read of `context[namespace].resolver`: it is a mutable,
    // time-sensitive transport slot (the operation-scope wrapper swaps it per field), while
    // `event.resolver` is the exact identity the hook is entitled to. Misuse fails LOUDLY at
    // access time instead of nondeterministically joining the wrong unit. Only the event's VIEW
    // is poisoned — the real context object is untouched.
    test('accessing event.context.autograph.resolver from a participant hook throws with guidance', async () => {
      let networkId;
      const hook = (event, next) => {
        networkId = event.context.network?.id; // every OTHER context property reads fine
        event.context.autograph.resolver.match('Person');
        next();
      };
      Emitter.onModels('preMutation', ['Person'], hook);

      try {
        await expect(resolver.match('Person').save({ name: 'ctx-guard', emailAddress: 'ctx-guard@example.com' }))
          .rejects.toThrow(/not accessible from event hooks.*event\.resolver/);
        expect(networkId).toBe('networkId');
        expect(await resolver.match('Person').where({ emailAddress: 'ctx-guard@example.com' }).many()).toHaveLength(0);
      } finally {
        Emitter.removeListener('preMutation', hook);
      }
    });

    test('an OBSERVER hits the same guard; assignment is also poisoned; the real context is untouched', async () => {
      let caught;
      const basicHook = (event) => {
        try {
          event.context.autograph.resolver = 'hijack'; // write is poisoned too
        } catch (e) {
          caught = e;
          event.context.stash = 'passthrough'; // non-resolver writes reach the REAL context
        }
      };
      Emitter.observeModels('postMutation', ['Person'], basicHook);

      let person;
      try {
        person = await resolver.match('Person').save({ name: 'ctx-guard-basic', emailAddress: 'ctx-guard-basic@example.com' });
        expect(caught?.message).toMatch(/not accessible from event hooks/);
        expect(context.stash).toBe('passthrough'); // the real context object received the write
        expect(context.autograph.resolver).toBe(resolver); // and its resolver slot is untouched
        // The escape hatch to the real object remains: event.resolver.getContext().
        expect(resolver.getContext().autograph.resolver).toBe(resolver);
      } finally {
        Emitter.removeListener('postMutation', basicHook);
        delete context.stash;
        if (person) await resolver.match('Person').id(person.id).delete();
      }
    });
  });
});
