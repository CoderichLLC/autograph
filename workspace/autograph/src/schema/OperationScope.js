const { getArgumentValues } = require('graphql');
const { PreOperationError, PostOperationError } = require('../service/ErrorService');

/**
 * Operation scope — every gqlMutation is a transaction; @transaction escalates the granularity
 * (TRANSACTIONS.md §4.17).
 *
 * Vocabulary: a **gqlMutation** is a root Mutation field invocation (the GraphQL entry point); an
 * **agMutation** is a data-layer write (`resolver.match().save()/push()/delete()/...`). The
 * ownership rule this module implements: gqlMutations OWN transaction boundaries; agMutations
 * only ever JOIN whatever scope is ambient on the resolver reference they run through (never
 * create one); RI/`*Many` ensure their own bounded units regardless (§4.5). Every scope has
 * exactly one owner — the same "autograph only opens transactions it can definitively close"
 * principle the RI/*Many auto-wrap states, applied at the transport entry point.
 *
 * `Schema#toObject()` wraps every root Mutation resolver — user-defined included, since user
 * precedence is applied *inside* AG's resolver merge — in this decorator. Per invocation:
 *
 *   - DEFAULT (no directive): **each gqlMutation is its own unit of work.** The wrapper runs the
 *     field through `resolver.withTransaction()` — the literal same public API a manual caller
 *     uses — against an isolated clone, swapping `context[namespace].resolver` to that clone for
 *     the duration of the field (root mutation fields are spec-serial, so plain assign+restore on
 *     the shared context is race-free; the field body and any custom code reading the context
 *     resolver joins the field's transaction). Commit when the field settles; rollback on a real
 *     failure; a PostOperationError commits (data complete, only response work failed). The
 *     caller-facing GraphQL contract is UNCHANGED — partial success across fields, data + errors
 *     — but each field now leaves nothing half-done: a postMutation participant failure rolls the
 *     field's write back instead of stranding it.
 *
 *   - `mutation @transaction { a, b, c }`: the caller escalates the unit of work from field to
 *     OPERATION, and **the operation executes as if it were a single resolver.** The FIRST live
 *     root field's invocation HOISTS the entire unit: it executes every live root field's
 *     resolver sequentially (document order — real resolver fns, arguments coerced from the
 *     document AST via graphql's own `getArgumentValues`, sibling `info`s constructed from the
 *     same objects the executor itself would use) against one shared transactional clone, then
 *     settles the transaction — commit or rollback — BEFORE returning anything. Subsequent field
 *     invocations are replay stubs: they return the recorded (already durable) result, or throw
 *     the recorded error at their own response path. The payoff is the response invariant the
 *     executor's own materialization order otherwise forbids: **the unit's fate is sealed before
 *     any field materializes into `data`, so `data` can never exhibit a rolled-back payload —
 *     regardless of field nullability.** On commit, every field presents its real durable result
 *     (per-field ledger); on rollback, every field errors (executed-then-undone and never-ran
 *     alike). No designated committer, no settle-state short-circuit, no non-null/null-propagation
 *     interplay — hoisting removes the temporal gap those mechanisms existed to police.
 *
 *   - An OPEN scope already on the request resolver (a host's in-place
 *     `transaction({ isolated: false })` — custom schema assembly / custom demarcation) means
 *     the host owns the whole request's unit: the wrapper stays out of the way entirely;
 *     agMutations join the host's scope ambiently and the host calls commit()/rollback() (§4.7).
 *
 * THE RESPONSE CONTRACT (transport parity with the agMutation caller — §4.15): a rejected
 * agMutation tells the backend developer two facts — WHAT PHASE failed (the error's type) and
 * WHETHER THE DATA LANDED (`PostOperationError.result`). The wrapper translates those onto the
 * outgoing error's `extensions` (graphql-js copies `originalError.extensions` verbatim onto the
 * response error), so the GraphQL consumer reads the same story:
 *
 *   code      — PRE_OPERATION_ERROR | POST_OPERATION_ERROR | MUTATION_ERROR (the failed write /
 *               participant itself) | OPERATION_ABORTED (this field was rolled back or never ran
 *               because a sibling field's failure aborted the @transaction unit)
 *   committed — the unit of work's durable fate: the settle decision the wrapper just made
 *
 * There is deliberately NO `result` extension: response payloads only ever flow through GraphQL
 * completion (selection sets, custom resolvers, crud visibility) — the raw doc is the agMutation
 * caller's channel, behind the trust boundary. A committed-but-response-layer-failed field is
 * `null` in `data` (spec: an errored field has no value) with `committed: true` on its error —
 * the caller refetches if they need it. The resulting invariant, with NO scenario-dependent
 * readings: a populated `data` field is ALWAYS a real, committed result; everything else lives
 * in `errors`, each entry self-describing.
 *
 * @transaction hoisting caveats: sibling resolvers run inside the first field's invocation, so
 * per-field tracing/APM spans attribute the whole unit's work to the first field, and a
 * fabricated sibling `info` (faithful — built from the executor's own schema/operation/fragments
 * objects) is what a custom resolver receives rather than an executor-born one. A mid-operation
 * real failure surfaces at the FIRST field's path under non-null fields (its replay throws
 * before the executor reaches the actual failing field; the cause is embedded in the message and
 * classified in extensions). Direct invocations that fabricate `info` WITHOUT a schema cannot be
 * hoisted (no type information to coerce sibling arguments) — they degrade to per-field units.
 * A live root field whose resolver was NOT wrapped by Schema#toObject() (merged into the
 * executable schema out-of-band) fails the whole unit loudly (OPERATION_ABORTED, before any
 * transaction opens) — the executor invokes such a field directly, outside the unit's reach, so
 * silently excluding it would degrade a declared-atomic operation to partial atomicity.
 *
 * Context caveat: the wrapper restores `context[namespace].resolver` when the field settles, so
 * un-awaited async work spawned inside a field that re-reads the context resolver LATER sees
 * whatever is then current — fire-and-forget work should capture `event.resolver` (arity < 2
 * listeners get the detached twin for exactly this reason, §4.18), not re-read the context.
 */

// Per-request shared-mode (@transaction) state, keyed by the request's ambient Resolver (one per
// request by convention). Entries are validated against the operation AST node — a reused
// resolver (scripts, tests) starting a NEW operation re-initializes cleanly; the AST node alone
// is NOT a safe key because Apollo caches parsed documents (same node across concurrent requests).
const states = new WeakMap();

// Phase classification by error type — the transport-side name for what the agMutation caller
// distinguishes by instanceof (see ErrorService.js).
const classify = (e) => {
  if (e instanceof PreOperationError) return 'PRE_OPERATION_ERROR';
  if (e instanceof PostOperationError) return 'POST_OPERATION_ERROR';
  return 'MUTATION_ERROR';
};

// Attach the response contract (see header) to an outgoing error, in place — the same error
// object rethrows all the way out (Boom.boomify mutates in place; withTransaction rethrows
// as-is), and graphql-js lifts `originalError.extensions` onto the response error verbatim.
const decorate = (e, committed, code = classify(e)) => {
  e.extensions = { ...e.extensions, code, committed };
  return e;
};

// @skip / @include evaluation against the operation's variable values.
const isSkipped = (sel, variableValues = {}) => (sel.directives ?? []).some((directive) => {
  const name = directive.name.value;
  if (name !== 'skip' && name !== 'include') return false;
  const arg = directive.arguments?.find(a => a.name.value === 'if');
  if (!arg) return false;
  const value = arg.value.kind === 'Variable' ? variableValues[arg.value.name.value] : arg.value.value;
  return name === 'skip' ? value === true : value !== true;
});

// The ordered live root selections that will invoke a wrapped resolver — flattening fragment
// spreads / inline fragments and honoring @skip/@include. Each entry carries the response key
// (alias ?? name), the field name, and the AST node(s) for sibling argument coercion and
// selection-tree building. DEDUPED BY RESPONSE KEY: GraphQL field merging allows the same key
// to be selected multiple times (identical field + args, enforced by validation) — the executor
// invokes the resolver ONCE with the merged fieldNodes, and the hoist must do exactly the same
// (two entries would run the write twice). Membership in `fields` (the resolver map itself)
// bounds the unit — but only introspection (`__typename`) is excluded SILENTLY: a REAL live
// field not in the map (a resolver merged into the executable schema outside Schema#toObject())
// is reported in `foreign` so the @transaction path can refuse loudly instead of degrading a
// declared-atomic operation to silent partial atomicity.
const liveSelections = (info, fields) => {
  const byKey = new Map();
  const foreign = new Set();
  const walk = nodes => nodes.forEach((sel) => {
    if (isSkipped(sel, info.variableValues)) return;
    switch (sel.kind) {
      case 'Field':
        if (typeof fields[sel.name.value] === 'function') {
          const key = (sel.alias ?? sel.name).value;
          if (byKey.has(key)) byKey.get(key).nodes.push(sel);
          else byKey.set(key, { key, name: sel.name.value, nodes: [sel] });
        } else if (!sel.name.value.startsWith('__')) {
          foreign.add(sel.name.value);
        }
        break;
      case 'FragmentSpread': { const fragment = info.fragments?.[sel.name.value]; if (fragment) walk(fragment.selectionSet.selections); break; }
      case 'InlineFragment': walk(sel.selectionSet.selections); break;
      default: break;
    }
  });
  walk(info.operation.selectionSet.selections);
  return { selections: [...byKey.values()], foreign: [...foreign] };
};

const wrapField = (fn, fields, namespace, directiveName) => {
  const wrapper = async (doc, args, context, info) => {
    const resolver = context?.[namespace]?.resolver;
    // No ambient resolver, or not executing as a mutation operation (a Mutation-type resolver
    // invoked some other way) — nothing to demarcate.
    if (!resolver || info?.operation?.operation !== 'mutation') return fn(doc, args, context, info);

    // Host-managed escape hatch: an OPEN scope on the request resolver means a host opened it
    // in place (transaction({ isolated: false })) and owns its settle — the whole request is the
    // host's unit of work. agMutations already join it ambiently; the wrapper stays out of the way.
    if (resolver.transactionScope?.state === 'open') return fn(doc, args, context, info);

    // Run a field body against a transactional clone: swap the context resolver in, restore on
    // settle. Root mutation fields are spec-serial, so assign+restore on the shared context is
    // race-free — nothing else reads it concurrently.
    const runWith = async (txn, thunk) => {
      const previous = context[namespace].resolver;
      context[namespace].resolver = txn;
      try {
        return await thunk();
      } finally {
        context[namespace].resolver = previous;
      }
    };

    // `mutation @transaction { ... }` — the operation executes as ONE unit via hoisting (see
    // header): the first live field runs everything and settles the transaction; every field's
    // invocation then reports its recorded outcome from a fate already sealed.
    if ((info.operation.directives ?? []).some(d => d.name.value === directiveName)) {
      const mutationType = info.schema?.getMutationType?.();

      if (mutationType) {
        // Re-init on a NEW operation, or on a NEW serial execution of the SAME document (a script
        // re-running one parsed document through one resolver): every serial execution starts at
        // the FIRST live selection, and replay of a completed hoist never re-arrives there first.
        let state = states.get(resolver);
        if (!state || state.operation !== info.operation || (state.done && info.path?.key === state.firstKey)) {
          const { selections, foreign } = liveSelections(info, fields);
          // A @transaction operation must be FULLY hoistable. A live root field with no wrapped
          // resolver (merged into the executable schema outside Schema#toObject()) is invoked by
          // the executor directly — the unit can neither carry nor suppress it — so it would
          // execute OUTSIDE the transaction: silent partial atomicity on a declared-atomic
          // operation. Refuse loudly BEFORE any transaction opens or any field runs. The state is
          // deliberately never recorded, so every wrapped field's invocation re-derives the same
          // refusal and reports it at its own response path.
          if (foreign.length) throw decorate(new Error(`Operation aborted: @transaction operation selects root field(s) [${foreign.join(', ')}] not carried by the unit — resolver(s) not wrapped by Schema#toObject() (merged out-of-band?)`), false, 'OPERATION_ABORTED');
          state = { operation: info.operation, selections, firstKey: selections[0]?.key, results: new Map(), done: false };
          states.set(resolver, state);
        }

        // HOIST — this is the first invocation of the unit: execute every live root field NOW,
        // in document order, against one shared clone; settle; record per-key outcomes. Nothing
        // materializes into `data` until the fate of everything is known.
        if (!state.done) {
          const txn = resolver.transaction();
          const poperrs = []; // response-layer failures — fate (commit/rollback) decided at settle
          let failure;
          let failedKey;

          for (const sel of state.selections) {
            if (failure) {
              // A real failure already aborted the unit — later fields never run.
              state.results.set(sel.key, { error: decorate(new Error(`Operation aborted: mutation '${failedKey}' failed (${failure.message})`), false, 'OPERATION_ABORTED') });
            } else {
              try {
                // Sibling invocation — the same inputs the executor itself would construct: args
                // coerced from the document AST + variableValues by graphql's own coercion, info
                // rebuilt from the executor-born schema/operation/fragments with this field's own
                // identity (fieldName/fieldNodes/returnType/path).
                const fieldDef = mutationType.getFields()[sel.name];
                // Merged same-key selections carry identical args by validation — coerce from the
                // first node; pass ALL nodes so selection-tree consumers see the merged set.
                const fieldArgs = getArgumentValues(fieldDef, sel.nodes[0], info.variableValues);
                const siblingInfo = { ...info, fieldName: sel.name, fieldNodes: sel.nodes, returnType: fieldDef.type, path: { prev: undefined, key: sel.key, typename: 'Mutation' } };
                const value = await runWith(txn, () => fields[sel.name](doc, fieldArgs, context, siblingInfo)); // eslint-disable-line no-await-in-loop
                state.results.set(sel.key, { value });
              } catch (e) {
                if (e instanceof PostOperationError) {
                  // Response-layer failure: the field's data is complete and correct — never
                  // abort-worthy. Whether it reads committed:true or false depends on how the
                  // UNIT settles below; decoration is deferred until then.
                  poperrs.push(e);
                  state.results.set(sel.key, { error: e });
                } else {
                  // Real failure — the whole unit aborts. Later fields record OPERATION_ABORTED
                  // above; earlier (executed-then-undone) fields are retracted at settle below.
                  failure = e;
                  failedKey = sel.key;
                  state.results.set(sel.key, { error: decorate(e, false) });
                }
              }
            }
          }

          try {
            if (failure) throw failure;
            await txn.commit();
            poperrs.forEach(e => decorate(e, true));
          } catch (e) {
            // Rollback (or the commit itself failed — same durable outcome: nothing landed).
            // Never let a secondary rollback failure mask the root cause.
            await txn.rollback().catch(() => {});
            failure ??= e;
            failedKey ??= '(commit)';
            poperrs.forEach(err => decorate(err, false));
            // Retract every executed-but-now-undone success: its value must never reach `data`.
            state.results.forEach((outcome, key) => {
              if (!('error' in outcome)) state.results.set(key, { error: decorate(new Error(`Operation rolled back: mutation '${failedKey}' failed (${failure.message})`), false, 'OPERATION_ABORTED') });
            });
          }
          state.done = true;
        }

        // REPLAY — report this field's recorded outcome. (A key not in the map means the executor
        // reached a selection the hoist walk didn't — defensive fallback to a per-field unit.)
        const outcome = state.results.get(info.path?.key);
        if (outcome) {
          if ('error' in outcome) throw outcome.error;
          return outcome.value;
        }
      }
      // No schema on `info` (direct, non-executor invocation — nothing to coerce sibling args
      // with, and no `data` tree to keep honest), or a selection the walk missed: degrade to the
      // default per-field unit below.
    }

    // DEFAULT: every gqlMutation is its own unit of work — commit on settle, rollback on real
    // failure, commit-and-rethrow on PostOperationError, all via the literal same public method
    // a manual caller uses. The GraphQL partial-success contract across fields is untouched.
    // withTransaction's settle decision, translated onto the wire: PostOperationError ⇒ it
    // committed anyway; anything else ⇒ it rolled back.
    return resolver.withTransaction(txn => runWith(txn, () => fn(doc, args, context, info))).catch((e) => {
      throw decorate(e, e instanceof PostOperationError);
    });
  };
  // Unwrap handle + idempotency marker: merge() paths can feed already-wrapped resolvers back
  // through toObject(); re-wrapping must build from the ORIGINAL fn with the (possibly larger)
  // merged field map, never stack wrappers (a stacked wrap would nest a second transaction
  // around every field and hoist against a stale field map).
  wrapper.$operationScope = fn;
  return wrapper;
};

/**
 * Wrap every root Mutation resolver in `resolvers` with the operation-scope decorator.
 * Idempotent by unwrap-and-rewrap: safe to call on resolver maps that already contain wrapped
 * functions (e.g. Schema#merge of another Schema's toObject()). Returns a new object; the
 * input map is not mutated.
 */
const wrapOperationScope = (resolvers, namespace, directiveName = 'transaction') => {
  const mutation = resolvers?.Mutation;
  if (!mutation) return resolvers;
  // The UNWRAPPED originals — both what each wrapper decorates and what a @transaction hoist
  // executes for sibling fields (hoisting through a wrapper would open nested transactions).
  const fields = Object.entries(mutation).reduce((prev, [name, fn]) => {
    return Object.assign(prev, { [name]: typeof fn === 'function' ? (fn.$operationScope ?? fn) : fn });
  }, {});
  const Mutation = Object.entries(fields).reduce((prev, [name, fn]) => {
    const target = typeof fn === 'function' ? wrapField(fn, fields, namespace, directiveName) : fn;
    return Object.assign(prev, { [name]: target });
  }, {});
  return { ...resolvers, Mutation };
};

module.exports = { wrapOperationScope };
