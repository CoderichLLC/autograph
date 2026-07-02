/**
 * Identity-based transaction bookkeeping for one logical unit of work.
 *
 * A scope tracks, per data-source client, whether it "owns" that client's session outright or
 * merely shares (is `coupled` to) an ancestor's — decided entirely by whether `client.transaction()`
 * handed back the exact same session object it was offered. MongoDB can't nest transactions, so it
 * always hands the parent session back unchanged (coupled); a savepoint-capable driver could hand
 * back a distinct handle instead. This class never asks "which driver is this" — it only reacts to
 * object identity, so it stays driver-agnostic by construction.
 *
 * A coupled client has nothing of its own to commit/rollback — its rollback propagates to the
 * parent because there is nothing partial to undo on a shared MongoDB session.
 */
module.exports = class TransactionScope {
  parent;
  independent;
  eager; // if true, reads bind a session too (getSession), not just writes — see Resolver#resolve
  #pending = new Map(); // client -> Promise<Entry>, claimed synchronously — see #claim
  #entries = new Map(); // client -> Entry ({ handle, coupled, queue }), populated once claimed
  #settled = []; // callbacks to run once this client's session is truly, finally sealed — see addSettled

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

  constructor({ parent = null, independent = false, eager = false } = {}) {
    this.parent = parent;
    this.independent = independent;
    this.eager = eager;
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
    if (!this.#pending.has(client)) {
      this.#pending.set(client, (async () => {
        const parentHandle = (this.parent && !this.independent) ? await this.parent.#getHandle(client) : undefined;
        const handle = await client.transaction(parentHandle);
        const entry = { handle, coupled: handle === parentHandle, queue: Promise.resolve() };
        this.#entries.set(client, entry);
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

  // Opportunistic, non-claiming lookup for reads: if a write earlier in this scope (or an
  // ancestor it's coupled to) already bound a session for this client, reuse it (read-your-own-
  // writes within the transaction) — but never trigger a new client.transaction() just to serve
  // a read that would otherwise need none.
  peekSession(client) {
    return this.#entries.get(client)?.handle.session ?? this.parent?.peekSession(client);
  }

  // Every physical driver call funnels through here so a shared (coupled) session never sees two
  // concurrent operations. Coupled clients delegate to whoever actually owns that session's queue.
  enqueue(client, fn) {
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
  addSettled(client, fn) {
    const entry = this.#entry(client);
    if (entry?.coupled) return this.parent.addSettled(client, fn);
    this.#settled.push(fn);
    return undefined;
  }

  async commit() {
    const entries = await Promise.all([...this.#pending.values()]);
    // allSettled, not all: we only need to know every enqueued operation has *finished*, not that
    // they all succeeded — a caller's own failed write already rejected their own call site; that
    // rejection must not also make commit()/rollback() throw a stale, unrelated error here.
    await Promise.allSettled(entries.map(e => e.queue));
    await Promise.all(entries.filter(e => !e.coupled).map(e => e.handle.commit()));
    await Promise.all(this.#settled.map(fn => fn()));
  }

  async rollback() {
    const entries = await Promise.all([...this.#pending.values()]);
    await Promise.allSettled(entries.map(e => e.queue));
    // Coupled means this scope shares a physical session with an ancestor — MongoDB has no
    // savepoints, so there is nothing partial to undo; the whole shared transaction must abort.
    if (entries.some(e => e.coupled)) await this.parent.rollback();
    await Promise.all(entries.filter(e => !e.coupled).map(e => e.handle.rollback()));
    await Promise.all(this.#settled.map(fn => fn()));
  }
};
