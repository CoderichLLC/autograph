class MyError extends Error {
  constructor(e) {
    super(e);
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

// Thrown by Resolver#createSystemEvent when a postMutation/preResponse/postResponse hook fails —
// the underlying write already succeeded. Resolver#withTransaction's commit-decision logic treats
// this specially: commit anyway (there is nothing to undo), then re-throw `.data` (the original
// cause) to the caller. `.result` carries the write's already-successful result even though this
// is an error, so a fan-out that catches it can still recover what was actually written.
exports.PostOperationError = class extends MyError {
  constructor(e, result) {
    super(e);
    this.result = result;
  }
};
