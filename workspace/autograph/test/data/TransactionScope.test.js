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

  describe('peekSession — read-your-own-writes without triggering a new session', () => {
    test('returns undefined before any write has bound a session', () => {
      const { client } = createMockClient();
      const scope = new TransactionScope();
      expect(scope.peekSession(client)).toBeUndefined();
    });

    test('returns the bound session once a write has claimed one, without opening another', async () => {
      const { client } = createMockClient();
      const scope = new TransactionScope();
      const session = await scope.getSession(client);

      expect(scope.peekSession(client)).toBe(session);
      expect(client.transaction).toHaveBeenCalledTimes(1);
    });

    test('falls back to the parent scope when this scope has not claimed its own session yet', async () => {
      const { client } = createMockClient();
      const parentScope = new TransactionScope();
      const parentSession = await parentScope.getSession(client);
      const childScope = new TransactionScope({ parent: parentScope });

      expect(childScope.peekSession(client)).toBe(parentSession);
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
