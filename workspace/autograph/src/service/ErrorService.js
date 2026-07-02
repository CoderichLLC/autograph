class MyError extends Error {
  constructor(e) {
    // Extract the cause's own message (Error(errorObject) would stringify it into
    // "Error: original message", double-prefixing); the full original cause stays on .data.
    super(e instanceof Error ? e.message : e);
    this.data = e;
  }
}
exports.AbortEarlyError = class extends MyError {};

// Thrown by Resolver#createSystemEvent when a preMutation/validate hook fails — the underlying
// write never happened, so this is always rollback-worthy (the default treatment for anything
// that ISN'T a PostOperationError already covers this — see Resolver#withTransaction). This class
// exists purely so a pre-write failure is symmetrically identifiable by phase, same as
// PostOperationError; nothing in the commit/rollback decision actually branches on it.
exports.PreOperationError = class extends MyError {};

// Thrown by Resolver#createSystemEvent when a hook fails AFTER a write that is beyond aborting:
// a PRESENTER-phase (preResponse/postResponse) failure — the data is correct, only presentation
// broke — or any post-phase failure on a write no transaction carried (already durable, nothing
// to undo). Resolver#withTransaction's commit-decision logic treats this specially: commit anyway,
// then re-throw to the caller. `.result` carries the write's already-successful result even
// though this is an error, so a fan-out that catches it can still recover what was actually
// written. NOTE: a postMutation (participant) failure on a transaction-carried write is NOT
// wrapped in this — it propagates plainly and aborts the unit (see §4.15 in TRANSACTIONS.md).
exports.PostOperationError = class extends MyError {
  constructor(e, result) {
    super(e);
    this.result = result;
  }
};
