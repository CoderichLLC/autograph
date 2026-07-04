const TransactionScope = require('../../src/data/TransactionScope');

// A fake driver "client" — matches the contract TransactionScope actually depends on:
// transaction(parentHandle) -> Promise<{ session, commit(), rollback() }>. Mongo-style by
// default: given a parent handle, hands it back unchanged (decomposition/coupling); with no
// parent, opens a brand-new handle. `handles` exposes every real (non-coupled) handle created so
// tests can inspect commit()/rollback() call counts directly.
function createMockClient() {
  const handles = [];
  const transaction = jest.fn((parentHandle) => {
    if (parentHandle) return Promise.resolve(parentHandle);
    const handle = {
      session: {},
      commit: jest.fn(() => Promise.resolve()),
      rollback: jest.fn(() => Promise.resolve()),
    };
    handles.push(handle);
    return Promise.resolve(handle);
  });
  return { client: { transaction }, handles };
}

describe('TransactionScope', () => {
  describe('identity-based coupling', () => {
    test('a child is coupled when the driver hands the parent handle back unchanged (Mongo-style — cannot nest)', async () => {
      const { client } = createMockClient();
      const parentScope = new TransactionScope();
      const parentSession = await parentScope.getSession(client);

      const childScope = new TransactionScope({ parent: parentScope });
      const childSession = await childScope.getSession(client);

      expect(childSession).toBe(parentSession);
    });

    test('a child is independent when the driver hands back a distinct handle (savepoint-capable driver)', async () => {
      // Ignores whatever parentHandle it's offered — always opens a fresh handle, the way a
      // driver that implements real nested transactions via SAVEPOINT would for a *different*
      // savepoint, never literally the same object as its parent's handle.
      const client = { transaction: jest.fn(() => Promise.resolve({ session: {}, commit: jest.fn(), rollback: jest.fn() })) };
      const parentScope = new TransactionScope();
      const parentSession = await parentScope.getSession(client);

      const childScope = new TransactionScope({ parent: parentScope });
      const childSession = await childScope.getSession(client);

      expect(childSession).not.toBe(parentSession);
    });

    test('forceIndependent (independent: true) never offers the parent handle to the driver at all', async () => {
      const { client } = createMockClient();
      const parentScope = new TransactionScope();
      await parentScope.getSession(client);

      const childScope = new TransactionScope({ parent: parentScope, independent: true });
      await childScope.getSession(client);

      // Called twice total (parent + child), and the child's call must have received no parent handle
      expect(client.transaction).toHaveBeenCalledTimes(2);
      expect(client.transaction).toHaveBeenNthCalledWith(2, undefined);
    });
  });

  describe('nested (savepoint) handles — partial rollback is real, commit defers fate to parent', () => {
    // Savepoint-capable fake: offered a parent handle, returns a DISTINCT handle (the way
    // PostgresDriver wraps SAVEPOINT/RELEASE/ROLLBACK TO). TransactionScope must classify this
    // as NESTED — not coupled (no shared-fate propagation), not independent (commit ≠ durable).
    function createSavepointClient() {
      const handles = [];
      const transaction = jest.fn((parentHandle) => {
        const handle = { session: {}, commit: jest.fn(() => Promise.resolve()), rollback: jest.fn(() => Promise.resolve()) };
        handles.push(handle);
        return Promise.resolve(handle);
      });
      return { client: { transaction }, handles };
    }

    test('nested commit hands settled callbacks up — they fire only at the PARENT\'s real commit', async () => {
      const { client } = createSavepointClient();
      const parent = new TransactionScope();
      await parent.getSession(client);
      const child = new TransactionScope({ parent });
      await child.getSession(client);

      const outcomes = [];
      child.addSettled(client, o => outcomes.push(o));
      await child.commit(); // RELEASE — provisional, NOT durability
      expect(outcomes).toEqual([]);

      await parent.commit();
      expect(outcomes).toEqual(['commit']);
    });

    test('a savepoint released into a transaction that later rolls back reports ROLLBACK', async () => {
      const { client } = createSavepointClient();
      const parent = new TransactionScope();
      await parent.getSession(client);
      const child = new TransactionScope({ parent });
      await child.getSession(client);

      const outcomes = [];
      child.addSettled(client, o => outcomes.push(o));
      await child.commit();
      await parent.rollback(); // the child's "committed" work is undone with the parent
      expect(outcomes).toEqual(['rollback']);
    });

    test('nested rollback is real and final — callbacks fire immediately, the parent SURVIVES', async () => {
      const { client, handles } = createSavepointClient();
      const parent = new TransactionScope();
      await parent.getSession(client);
      const child = new TransactionScope({ parent });
      await child.getSession(client);

      const childOutcomes = [];
      const parentOutcomes = [];
      child.addSettled(client, o => childOutcomes.push(o));
      parent.addSettled(client, o => parentOutcomes.push(o));

      await child.rollback(); // ROLLBACK TO SAVEPOINT — partial, definitive
      expect(childOutcomes).toEqual(['rollback']); // fired NOW, not at parent settle
      expect(parent.state).toBe('open'); // no coupled-style propagation

      await parent.commit();
      expect(parentOutcomes).toEqual(['commit']);
      const [parentHandle, childHandle] = handles;
      expect(childHandle.rollback).toHaveBeenCalledTimes(1);
      expect(parentHandle.rollback).not.toHaveBeenCalled();
      expect(parentHandle.commit).toHaveBeenCalledTimes(1);
    });

    test('savepoint-under-savepoint chains the handoff — the TOP owner\'s outcome wins', async () => {
      const { client } = createSavepointClient();
      const top = new TransactionScope();
      await top.getSession(client);
      const mid = new TransactionScope({ parent: top });
      await mid.getSession(client);
      const leaf = new TransactionScope({ parent: mid });
      await leaf.getSession(client);

      const outcomes = [];
      leaf.addSettled(client, o => outcomes.push(o));
      await leaf.commit(); // hands to mid
      await mid.commit(); // hands to top
      expect(outcomes).toEqual([]);
      await top.rollback();
      expect(outcomes).toEqual(['rollback']);
    });
  });

  describe('async claim race (regression)', () => {
    // Bug: the original #getHandle checked `has(client)` before awaiting client.transaction(),
    // so N concurrent callers (e.g. a *Many batch firing N .save() calls via Promise.all) would
    // each see "no entry yet" and each open its own separate, independently-committed transaction
    // — only the last one to finish ever actually got committed via scope.commit(). Fixed by
    // claiming the client's entry with the in-flight promise itself, synchronously.
    test('many concurrent getSession() calls for the same client open exactly one transaction', async () => {
      const { client } = createMockClient();
      const scope = new TransactionScope();

      const sessions = await Promise.all(Array.from({ length: 50 }, () => scope.getSession(client)));

      expect(client.transaction).toHaveBeenCalledTimes(1);
      sessions.forEach(session => expect(session).toBe(sessions[0]));
    });
  });

  describe('commit()/rollback() do not propagate a stale prior rejection (regression)', () => {
    // Bug: commit()/rollback() awaited each session's queue with Promise.all — so if the *last*
    // enqueued write had already failed (and its rejection was already handled at its own call
    // site), commit()/rollback() would ALSO reject with that same stale error, corrupting a
    // caller's own, unrelated error handling around commit()/rollback(). Fixed with allSettled.
    test('commit() resolves even though a prior enqueue()d write rejected', async () => {
      const { client } = createMockClient();
      const scope = new TransactionScope();
      await scope.getSession(client);

      await expect(scope.enqueue(client, () => Promise.reject(new Error('write failed')))).rejects.toThrow('write failed');
      await expect(scope.commit()).resolves.toBeUndefined();
    });

    test('rollback() resolves even though a prior enqueue()d write rejected', async () => {
      const { client } = createMockClient();
      const scope = new TransactionScope();
      await scope.getSession(client);

      await expect(scope.enqueue(client, () => Promise.reject(new Error('write failed')))).rejects.toThrow('write failed');
      await expect(scope.rollback()).resolves.toBeUndefined();
    });
  });

  describe('commit()/rollback() only touch sessions this scope actually owns', () => {
    test('a coupled scope\'s commit() never calls the shared handle\'s commit() — only the real owner\'s does', async () => {
      const { client, handles } = createMockClient();
      const parentScope = new TransactionScope();
      await parentScope.getSession(client);
      const childScope = new TransactionScope({ parent: parentScope });
      await childScope.getSession(client);

      await childScope.commit();
      expect(handles[0].commit).not.toHaveBeenCalled();

      await parentScope.commit();
      expect(handles[0].commit).toHaveBeenCalledTimes(1);
    });

    test('a coupled scope\'s rollback() propagates to the parent — there is nothing partial to undo on a shared session', async () => {
      const { client, handles } = createMockClient();
      const parentScope = new TransactionScope();
      await parentScope.getSession(client);
      const childScope = new TransactionScope({ parent: parentScope });
      await childScope.getSession(client);

      await childScope.rollback();
      expect(handles[0].rollback).toHaveBeenCalledTimes(1);
    });

    test('an independent scope only settles its own handle, never its parent\'s', async () => {
      const { client, handles } = createMockClient();
      const parentScope = new TransactionScope();
      await parentScope.getSession(client);
      const childScope = new TransactionScope({ parent: parentScope, independent: true });
      await childScope.getSession(client);

      await childScope.commit();
      expect(handles[0].commit).not.toHaveBeenCalled(); // parent's handle, untouched
      expect(handles[1].commit).toHaveBeenCalledTimes(1); // child's own, independent handle
    });
  });

  describe('settle-state — commit()/rollback() are idempotent, stale use fails loudly', () => {
    test('double commit() only touches the driver handle once (memoized settlement)', async () => {
      const { client, handles } = createMockClient();
      const scope = new TransactionScope();
      await scope.getSession(client);

      await scope.commit();
      await scope.commit();
      expect(handles[0].commit).toHaveBeenCalledTimes(1);
      expect(scope.state).toBe('committed');
    });

    test('rollback() after commit() is a no-op — the transaction\'s fate is already sealed', async () => {
      const { client, handles } = createMockClient();
      const scope = new TransactionScope();
      await scope.getSession(client);

      await scope.commit();
      await scope.rollback();
      expect(handles[0].rollback).not.toHaveBeenCalled();
      expect(scope.state).toBe('committed');
    });

    test('getSession() against a settled scope rejects with a clear AG-level error, not a raw driver one', async () => {
      const { client } = createMockClient();
      const scope = new TransactionScope();
      await scope.getSession(client);
      await scope.commit();

      await expect(scope.getSession(client)).rejects.toThrow(/already committed/);
    });

    test('enqueue() against a settled scope throws a clear AG-level error', async () => {
      const { client } = createMockClient();
      const scope = new TransactionScope();
      await scope.getSession(client);
      await scope.rollback();

      expect(() => scope.enqueue(client, () => Promise.resolve())).toThrow(/already rolledBack/);
    });

    test('joining (coupled) a parent that has already settled rejects clearly', async () => {
      const { client } = createMockClient();
      const parentScope = new TransactionScope();
      await parentScope.getSession(client);
      await parentScope.commit();

      const childScope = new TransactionScope({ parent: parentScope });
      await expect(childScope.getSession(client)).rejects.toThrow(/already committed/);
    });
  });

  describe('addSettled — outcome-aware, deduped, isolated', () => {
    test('settled callbacks receive the outcome (commit vs rollback)', async () => {
      const { client } = createMockClient();
      const outcomes = [];

      const committed = new TransactionScope();
      await committed.getSession(client);
      committed.addSettled(client, o => outcomes.push(o));
      await committed.commit();

      const rolledBack = new TransactionScope();
      await rolledBack.getSession(client);
      rolledBack.addSettled(client, o => outcomes.push(o));
      await rolledBack.rollback();

      expect(outcomes).toEqual(['commit', 'rollback']);
    });

    test('dedupes by key — N writes to one model need only one settle-time cache clear', async () => {
      const { client } = createMockClient();
      const scope = new TransactionScope();
      await scope.getSession(client);

      const fn = jest.fn();
      scope.addSettled(client, fn, 'clear:Person');
      scope.addSettled(client, fn, 'clear:Person');
      scope.addSettled(client, fn, 'clear:Book');
      await scope.commit();

      expect(fn).toHaveBeenCalledTimes(2); // Person once, Book once
    });

    test('runs immediately (with the outcome) if the owner has already settled — its condition is already met', async () => {
      const { client } = createMockClient();
      const scope = new TransactionScope();
      await scope.getSession(client);
      await scope.commit();

      const fn = jest.fn();
      scope.addSettled(client, fn);
      expect(fn).toHaveBeenCalledWith('commit');
    });

    test('a throwing settled callback never turns a successful commit into a rejected commit()', async () => {
      const { client } = createMockClient();
      const scope = new TransactionScope();
      await scope.getSession(client);
      scope.addSettled(client, () => { throw new Error('settled callback failure'); });

      await expect(scope.commit()).resolves.toBeUndefined();
    });
  });

  describe('run() — the physical front door serializes EVERY sessioned call (reads and writes)', () => {
    // Regression: sessioned reads (DataLoader dispatches, *Many pre-image #gets, FK-validation
    // reads) used to bypass the enqueue() queue and race in-flight writes on the same session —
    // MongoDB supports exactly one in-flight operation per session. run() routes any sessioned
    // call through the owning scope's queue; sessionless calls pass straight through.
    const overlappingProbe = () => {
      let active = 0;
      let maxActive = 0;
      const probe = () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        return new Promise((r) => { setTimeout(r, 5); }).then(() => { active -= 1; });
      };
      return { probe, max: () => maxActive };
    };

    test('sessioned calls via run() never overlap each other or enqueue()d writes', async () => {
      const { client } = createMockClient();
      const scope = new TransactionScope();
      const session = await scope.getSession(client);
      const { probe, max } = overlappingProbe();

      await Promise.all([
        TransactionScope.run(session, probe), // a "read"
        scope.enqueue(client, probe), // a "write"
        TransactionScope.run(session, probe), // another "read"
      ]);

      expect(max()).toBe(1);
    });

    test('a coupled child\'s sessioned calls serialize through the same (owner\'s) queue', async () => {
      const { client } = createMockClient();
      const parentScope = new TransactionScope();
      const parentSession = await parentScope.getSession(client);
      const childScope = new TransactionScope({ parent: parentScope });
      const childSession = await childScope.getSession(client); // same physical session (coupled)
      const { probe, max } = overlappingProbe();

      await Promise.all([
        TransactionScope.run(parentSession, probe),
        TransactionScope.run(childSession, probe),
        childScope.enqueue(client, probe),
      ]);

      expect(max()).toBe(1);
    });

    test('sessionless calls pass straight through — still genuinely parallel', async () => {
      const { probe, max } = overlappingProbe();
      await Promise.all([TransactionScope.run(undefined, probe), TransactionScope.run(undefined, probe)]);
      expect(max()).toBe(2);
    });

    test('an unknown (caller-provided) session no scope owns passes through rather than failing', async () => {
      const foreignSession = {};
      await expect(TransactionScope.run(foreignSession, () => Promise.resolve('ok'))).resolves.toBe('ok');
    });

    test('run() against a settled owner rejects — never throws synchronously', async () => {
      const { client } = createMockClient();
      const scope = new TransactionScope();
      const session = await scope.getSession(client);
      await scope.commit();

      let pending;
      expect(() => { pending = TransactionScope.run(session, () => Promise.resolve()); }).not.toThrow();
      await expect(pending).rejects.toThrow(/already committed/);
    });
  });

  describe('tagSession (regression)', () => {
    // Used by DataLoader's batch-merge fingerprint to keep a session-bound read from being merged
    // into the same driver call as a session-less or differently-sessioned one. Must never expose
    // the raw session — MongoDB's ClientSession has circular references that would blow up
    // JSON.stringify (DataLoader fingerprints via JSON.stringify).
    test('gives a stable tag for the same session and distinct tags for different sessions', () => {
      const sessionA = {};
      sessionA.circular = sessionA; // simulate a real ClientSession's circular structure
      const sessionB = {};

      const tagA1 = TransactionScope.tagSession(sessionA);
      const tagA2 = TransactionScope.tagSession(sessionA);
      const tagB = TransactionScope.tagSession(sessionB);

      expect(tagA1).toBe(tagA2);
      expect(tagA1).not.toBe(tagB);
    });

    test('returns undefined for no session, and never leaks the raw (possibly circular) session object', () => {
      const session = {};
      session.circular = session;
      const tag = TransactionScope.tagSession(session);

      expect(TransactionScope.tagSession(undefined)).toBeUndefined();
      expect(TransactionScope.tagSession(null)).toBeUndefined();
      expect(() => JSON.stringify({ session: tag })).not.toThrow();
    });
  });
});
