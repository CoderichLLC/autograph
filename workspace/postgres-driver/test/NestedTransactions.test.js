const { Emitter } = require('@coderich/autograph-db-tests');

describe('Nested transactions (SAVEPOINT) — PG-specific semantics', () => {
  // PostgresDriver answers transaction(parentHandle) with a DISTINCT savepoint handle, so a
  // child scope is NESTED (not Mongo-style coupled/shared-fate): its rollback is a real partial
  // rollback (ROLLBACK TO SAVEPOINT — the parent transaction survives, and on real Postgres is
  // un-poisoned from the 25P02 aborted state), and its commit (RELEASE) is NOT durability — the
  // parent still owns the fate. These tests pin the divergence from MongoDB, where the same
  // sequences are shared-fate.
  let resolver;

  beforeAll(() => {
    ({ resolver } = global);
  });

  const names = ['sp-keeper', 'sp-after', 'sp-batch-ok', 'sp-parent', 'sp-child', 'sp-evt-a', 'sp-evt-b'];
  afterEach(async () => {
    const rows = await global.resolver.match('Person').where({ name: names }).many();
    await Promise.all(rows.map(r => global.resolver.match('Person').id(r.id).delete()));
  });

  test('a failed *Many batch inside a manual txn is CONTAINED — the txn survives it and commits', async () => {
    const txn = resolver.transaction();
    await txn.match('Person').save({ name: 'sp-keeper', emailAddress: 'sp-keeper@example.com' });

    // The *Many auto-wrap opens a savepoint child; item 2 collides on the unique name index →
    // the child rolls back to its savepoint (item 1 of the batch undone WITH it) and rethrows.
    await expect(txn.match('Person').save([
      { name: 'sp-batch-ok', emailAddress: 'sp-batch-ok@example.com' },
      { name: 'sp-keeper', emailAddress: 'sp-dup@example.com' }, // duplicate name
    ])).rejects.toThrow(/duplicate/gi);

    // The transaction is still open and usable — on Mongo the coupled child's rollback would
    // have aborted the whole unit; on real Postgres WITHOUT savepoints the error would have
    // poisoned the transaction (25P02) and this write could never succeed.
    await txn.match('Person').save({ name: 'sp-after', emailAddress: 'sp-after@example.com' });
    await txn.commit();

    expect(await resolver.match('Person').where({ name: 'sp-keeper' }).one()).not.toBeNull();
    expect(await resolver.match('Person').where({ name: 'sp-after' }).one()).not.toBeNull();
    expect(await resolver.match('Person').where({ name: 'sp-batch-ok' }).one()).toBeNull(); // batch fully undone
  });

  test('a manual child scope rolls back PARTIALLY — the parent txn survives and commits its own work', async () => {
    const txn = resolver.transaction();
    await txn.match('Person').save({ name: 'sp-parent', emailAddress: 'sp-parent@example.com' });

    const child = txn.transaction(); // coupled (default): offered the ambient scope → savepoint
    await child.match('Person').save({ name: 'sp-child', emailAddress: 'sp-child@example.com' });
    await child.rollback(); // ROLLBACK TO SAVEPOINT — undoes ONLY the child's write

    // Parent still open, its pre-child write intact and visible to it.
    expect(await txn.match('Person').where({ name: 'sp-parent' }).one()).not.toBeNull();
    expect(await txn.match('Person').where({ name: 'sp-child' }).one()).toBeNull();
    await txn.commit();

    expect(await resolver.match('Person').where({ name: 'sp-parent' }).one()).not.toBeNull();
    expect(await resolver.match('Person').where({ name: 'sp-child' }).one()).toBeNull();
  });

  test('durable-outcome events respect nesting: RELEASE is not postCommit; ROLLBACK TO is postRollback now', async () => {
    const events = [];
    const disposers = [
      Emitter.on({ event: 'postCommit', model: 'Person' }, ({ query }) => { events.push(`commit:${query.input.name}`); }),
      Emitter.on({ event: 'postRollback', model: 'Person' }, ({ query }) => { events.push(`rollback:${query.input.name}`); }),
    ];

    try {
      const txn = resolver.transaction();

      const committer = txn.transaction();
      await committer.match('Person').save({ name: 'sp-evt-a', emailAddress: 'sp-evt-a@example.com' });
      await committer.commit(); // RELEASE SAVEPOINT — provisional, fate still owned by txn
      expect(events).toEqual([]); // postCommit must NOT fire yet

      const abandoner = txn.transaction();
      await abandoner.match('Person').save({ name: 'sp-evt-b', emailAddress: 'sp-evt-b@example.com' });
      await abandoner.rollback(); // ROLLBACK TO SAVEPOINT — definitively undone
      expect(events).toEqual(['rollback:sp-evt-b']); // postRollback fires promptly, pre-parent-settle

      await txn.commit(); // the true seal — NOW sp-evt-a's write is durable
      expect(events).toEqual(['rollback:sp-evt-b', 'commit:sp-evt-a']);
    } finally {
      disposers.forEach(dispose => dispose());
    }
  });
});
