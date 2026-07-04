/**
 * Identity-based transaction bookkeeping for one logical unit of work.
 *
 * A scope tracks, per data-source client, its relationship to that client's session — decided
 * entirely by object identity against what `client.transaction(parentHandle)` hands back. This
 * class never asks "which driver is this"; three relationships fall out:
 *
 *   - COUPLED: the driver returned the offered parent handle unchanged (MongoDB — a session
 *     supports exactly one transaction). Nothing of its own to commit/rollback; rollback
 *     propagates to the parent because there is nothing partial to undo on a shared session.
 *   - NESTED: offered a parent handle, got a DISTINCT one back (PostgresDriver — SAVEPOINT).
 *     Rollback is real and partial (undoes only this scope's work, parent survives), but commit
 *     is NOT durability — it merely folds this scope's work into the parent's fate, so settled
 *     callbacks (postCommit/postRollback, cache clears) are handed UP to the parent at commit
 *     and only fire when the true owner seals (see #settle).
 *   - INDEPENDENT: no parent offered (top of a unit, or `coupled: false`). Own commit/rollback
 *     are the real, durable thing.
 */
module.exports = class TransactionScope {
  parent;
  independent;
  #state = 'open'; // 'open' | 'committed' | 'rolledBack' — set exactly once, synchronously, by commit()/rollback()
  #settlement; // memoized commit()/rollback() promise — repeat calls return it rather than re-settling
  #pending = new Map(); // client -> Promise<Entry>, claimed synchronously — see #claim
  #entries = new Map(); // client -> Entry ({ handle, coupled, queue }), populated once claimed
  #settled = []; // callbacks to run once this client's session is truly, finally sealed — see addSettled
  #settledKeys = new Set(); // dedupe keys for addSettled — N writes to one model need only one clear thunk

  // Tags a session object with a small, stable, JSON-safe id — never the raw session itself
  // (MongoDB's ClientSession has circular references that would blow up JSON.stringify). Used by
  // DataLoader's batch-merge fingerprint so a session-bound read is never merged into the same
  // driver call as a session-less or differently-sessioned one. Static/shared across scopes: two
  // different TransactionScope instances can hand back the same underlying session (coupled), and
  // the tag must reflect that — it identifies the session, not which scope reached it.
  static #tags = new WeakMap();
  static #seq = 0;
  static tagSession(session) {
    if (!session) return undefined;
    if (!this.#tags.has(session)) this.#tags.set(session, ++this.#seq);
    return this.#tags.get(session);
  }

  // session -> { scope, client }: which scope owns this session's serialization queue. Registered
  // at claim time by the scope that opened a real (non-coupled) handle; first-owner-wins so a
  // hypothetical savepoint driver that returns a distinct handle wrapping the SAME session object
  // still funnels every physical call through one queue. Keyed weakly — dies with the session.
  static #owners = new WeakMap();

  /**
   * The front door for EVERY physical driver call that carries a session — reads and writes alike.
   * A MongoDB session supports exactly one in-flight operation at a time; writes were always
   * serialized through their scope's queue, but sessioned reads (DataLoader dispatches, *Many
   * pre-image #get's, FK-validation reads) used to bypass it and race the writes — an intermittent,
   * latency-dependent violation of the driver contract that an in-memory test server never shows.
   * Sessionless calls (or a session no scope knows about, e.g. caller-provided) pass straight through.
   */
  static run(session, fn) {
    const owner = session ? TransactionScope.#owners.get(session) : undefined;
    if (!owner) return fn();
    try {
      return owner.scope.enqueue(owner.client, fn);
    } catch (e) {
      return Promise.reject(e); // e.g. the owning scope already settled — reject, never throw sync
    }
  }

  constructor({ parent = null, independent = false } = {}) {
    this.parent = parent;
    this.independent = independent;
  }

  /**
   * 'open' until commit()/rollback() is called on this scope, then 'committed'/'rolledBack' —
   * settled scopes refuse new sessions/operations (loud AG-level error instead of a raw driver
   * "session ended" error); a read through a settled scope degrades to a plain, committed-state
   * read — see Resolver#resolve.
   */
  get state() {
    return this.#state;
  }

  #assertOpen(action) {
    if (this.#state !== 'open') throw new Error(`TransactionScope already ${this.#state}; cannot ${action} — this transaction has settled`);
  }

  // client.transaction() returns a HANDLE — { session, commit(), rollback() } — not the raw
  // native session itself. Coupling is decided by comparing handles (a driver that can't nest
  // hands the parent's handle straight back), but callers need the raw session for query.options.
  //
  // Claimed SYNCHRONOUSLY (the promise is stored before anything is awaited) — many concurrent
  // callers can ask for the same client's session in the same tick (e.g. a *Many batch firing
  // N .save() calls via Promise.all); without claiming synchronously, each would see "no entry
  // yet" and open its own separate, independently-committed Mongo transaction.
  #claim(client) {
    this.#assertOpen('open a session'); // also guards joining a parent that has already settled (via #getHandle)
    if (!this.#pending.has(client)) {
      this.#pending.set(client, (async () => {
        const parentHandle = (this.parent && !this.independent) ? await this.parent.#getHandle(client) : undefined;
        const handle = await client.transaction(parentHandle);
        // nested = offered a parent, got a distinct handle back (a real sub-transaction, e.g. a
        // Postgres SAVEPOINT): its rollback is partial and real; its commit defers fate to parent.
        const entry = { handle, coupled: handle === parentHandle, nested: parentHandle !== undefined && handle !== parentHandle, queue: Promise.resolve() };
        this.#entries.set(client, entry);
        if (!entry.coupled && !TransactionScope.#owners.has(handle.session)) TransactionScope.#owners.set(handle.session, { scope: this, client });
        return entry;
      })());
    }
    return this.#pending.get(client);
  }

  async #getHandle(client) {
    return (await this.#claim(client)).handle;
  }

  async getSession(client) {
    return (await this.#claim(client)).handle.session;
  }

  // Safe to read synchronously: every caller awaits getSession(client) for this client first, by
  // which point #claim(client) has already resolved and populated #entries.
  #entry(client) {
    return this.#entries.get(client);
  }

  // Every physical driver call funnels through here (via the static run() front door, or directly
  // for writes) so a shared (coupled) session never sees two concurrent operations. Coupled
  // clients delegate to whoever actually owns that session's queue.
  enqueue(client, fn) {
    this.#assertOpen('enqueue an operation');
    const entry = this.#entry(client);
    if (entry.coupled) return this.parent.enqueue(client, fn);
    entry.queue = entry.queue.then(fn, fn);
    return entry.queue;
  }

  // Defer fn until this client's session is truly, finally sealed (committed or rolled back) —
  // not just "this scope's own commit()/rollback() was called," which for a coupled scope happens
  // immediately and is a no-op at the driver level. Needed because DataLoaders are shared across a
  // whole request (see Resolver#clone): a write clears the cache immediately, but a read that
  // lands in the window between that write and the session's real commit can cache a pre-commit
  // view that would otherwise never get invalidated. Routes per-client, same as enqueue — a scope
  // can be coupled for one client and independent for another.
  //
  // fn receives the outcome ('commit' | 'rollback') when it eventually runs. `key`, if given,
  // dedupes: N writes to the same model only need one settle-time cache clear, not N.
  // If the true owner has already settled, fn runs immediately — its condition is already met.
  //
  // NESTED entries keep their callbacks HERE at registration (unlike coupled, which route to the
  // parent immediately) because the routing depends on how this scope settles: a nested rollback
  // is real and final (fire now), a nested commit is provisional (hand up to the parent) — see
  // #settle. The client is retained alongside fn so #settle can re-route per entry.
  addSettled(client, fn, key) {
    if (this.#state !== 'open') return fn(this.#state === 'committed' ? 'commit' : 'rollback');
    const entry = this.#entry(client);
    if (entry?.coupled) return this.parent.addSettled(client, fn, key);
    if (key !== undefined) {
      if (this.#settledKeys.has(key)) return undefined;
      this.#settledKeys.add(key);
    }
    this.#settled.push({ client, fn });
    return undefined;
  }

  // Idempotent: the first call settles; repeat calls (commit-after-commit, rollback-after-commit —
  // e.g. a coupled child propagating rollback to a parent that a withTransaction wrapper also
  // settles) return the same memoized settlement rather than re-running settled callbacks or
  // re-touching driver handles.
  commit() {
    if (this.#state !== 'open') return this.#settlement;
    this.#state = 'committed';
    this.#settlement = this.#settle('commit');
    return this.#settlement;
  }

  rollback() {
    if (this.#state !== 'open') return this.#settlement;
    this.#state = 'rolledBack';
    this.#settlement = this.#settle('rollback');
    return this.#settlement;
  }

  async #settle(outcome) {
    // allSettled on the claims: a claim that failed to even open (client.transaction rejected)
    // has nothing to settle, and its rejection already surfaced at the call site that triggered
    // it — it must not resurface here.
    const claims = await Promise.allSettled([...this.#pending.values()]);
    const entries = claims.filter(c => c.status === 'fulfilled').map(c => c.value);

    // allSettled, not all: we only need to know every enqueued operation has *finished*, not that
    // they all succeeded — a caller's own failed write already rejected their own call site; that
    // rejection must not also make commit()/rollback() throw a stale, unrelated error here.
    await Promise.allSettled(entries.map(e => e.queue));

    if (outcome === 'commit') {
      await Promise.all(entries.filter(e => !e.coupled).map(e => e.handle.commit()));
    } else {
      // Coupled means this scope shares a physical session with an ancestor — MongoDB has no
      // savepoints, so there is nothing partial to undo; the whole shared transaction must abort.
      if (entries.some(e => e.coupled)) await this.parent.rollback();
      await Promise.all(entries.filter(e => !e.coupled).map(e => e.handle.rollback()));
    }

    // Route each settled callback by how its client's entry actually sealed. A NESTED commit
    // (e.g. RELEASE SAVEPOINT) is not durability — the parent still owns the fate, so those
    // callbacks are re-registered on the parent and fire with the PARENT's eventual outcome
    // (a savepoint released into a transaction that later rolls back must report 'rollback').
    // A nested ROLLBACK is real and final (the work is definitively undone) — fire now, like
    // every independent settle. Keys are not forwarded: dedupe already applied at this level,
    // and a duplicate cache-clear at the parent is harmless while a false dedupe is not.
    const handoff = outcome === 'commit' && this.parent
      ? this.#settled.filter(({ client }) => this.#entries.get(client)?.nested)
      : [];
    const local = this.#settled.filter(s => !handoff.includes(s));
    handoff.forEach(({ client, fn }) => this.parent.addSettled(client, fn));

    // Settled callbacks are isolated (allSettled): the transaction's fate is already sealed above;
    // a throwing callback must never turn a successful commit into a rejected commit() promise.
    await Promise.allSettled(local.map(({ fn }) => Promise.resolve().then(() => fn(outcome))));
  }
};
