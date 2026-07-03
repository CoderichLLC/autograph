const { graphql, execute: executeDocument, parse } = require('graphql');
const { makeExecutableSchema } = require('@graphql-tools/schema');
const Emitter = require('../../src/data/Emitter');
const Resolver = require('../../src/data/Resolver');
const { wrapOperationScope } = require('../../src/schema/OperationScope');

describe('OperationScope — every gqlMutation is a transaction; @transaction escalates to the operation', () => {
  let resolver; // the shared global resolver — used only for out-of-band verification reads
  let $schema; // the Schema class instance (global.schema is the parsed POJO)
  let xschema;
  let failOn;

  beforeAll(() => {
    ({ resolver, $schema } = global);
    xschema = makeExecutableSchema($schema.toObject());

    // Deterministic "real failure" injection: any mutation whose input name starts with "fail"
    // aborts before the write (PreOperationError — a genuine, rollback-worthy failure). Person
    // name is normalized toLowerCase by its pipeline, so compare case-insensitively.
    failOn = (event, next) => {
      if (`${event.query.input?.name}`.toLowerCase().startsWith('fail')) throw new Error('deliberate-op-failure');
      next();
    };
    Emitter.on('preMutation', failOn);
  });

  afterAll(() => {
    Emitter.removeListener('preMutation', failOn);
  });

  // Simulates one HTTP request exactly the way test/server.js does: a fresh per-request context
  // object with a fresh Resolver registered onto it, executed against the executable schema
  // built from Schema#toObject() (whose Mutation resolvers carry the operation-scope wrap).
  const execute = async (source, variableValues) => {
    const contextValue = { network: { id: 'networkId' } };
    const requestResolver = new Resolver({ schema: $schema, context: contextValue });
    const result = await graphql({ schema: xschema, source, contextValue, variableValues });
    return { result, requestResolver };
  };

  const rowsByEmail = email => resolver.match('Person').where({ emailAddress: email }).many();
  const cleanupByEmail = async (...emails) => {
    const leftovers = await resolver.match('Person').where({ emailAddress: emails }).many();
    await Promise.all(leftovers.map(p => resolver.match('Person').id(p.id).delete()));
  };

  test('toObject() wraps every root Mutation resolver, unwrap-and-rewrap idempotent', () => {
    const r1 = $schema.toObject().resolvers;
    const r2 = $schema.toObject().resolvers;
    Object.values(r1.Mutation).forEach(fn => expect(typeof fn.$operationScope).toBe('function'));
    // Same underlying fn across calls; wrappers never stack (a double wrap would double-decrement).
    expect(r1.Mutation.createPerson.$operationScope).toBe(r2.Mutation.createPerson.$operationScope);
    expect(r1.Mutation.createPerson.$operationScope.$operationScope).toBeUndefined();
    // Query resolvers are untouched.
    expect(r1.Query.getPerson.$operationScope).toBeUndefined();
  });

  describe('default — each gqlMutation is its own unit of work (no directive)', () => {
    test('a single gqlMutation runs carried: the scope lives on a CLONE, never the request resolver', async () => {
      let captured;
      const spy = (event, next) => { captured = event.resolver; next(); };
      Emitter.onKeys('postMutation', ['createPerson'], spy);

      try {
        const { result, requestResolver } = await execute(`mutation {
          a: createPerson(input: { name: "opscope-single", emailAddress: "opscope-single@example.com" }) { id }
        }`);

        expect(result.errors).toBeUndefined();
        expect(requestResolver.transactionScope).toBeUndefined(); // never scoped in place
        expect(captured).not.toBe(requestResolver); // the field ran against a transactional clone...
        expect(captured.transactionScope.state).toBe('committed'); // ...whose unit sealed at field settle
        expect(await resolver.match('Person').id(result.data.a.id).one()).not.toBeNull();

        await resolver.match('Person').id(result.data.a.id).delete();
      } finally {
        Emitter.removeListener('postMutation', spy);
      }
    });

    test('a postMutation (participant) failure rolls the gqlMutation\'s write BACK — nothing is left half-done', async () => {
      // The behavior that per-field carry buys: through GraphQL, a bare single mutation is no
      // longer an "uncarried" write (whose participant failure would strand the write with a
      // PostOperationError) — the field's transaction aborts, write and all.
      const participant = async (event, next) => {
        if (`${event.query.input?.name}` === 'opscope-abort-participant') throw new Error('participant failure');
        next();
      };
      Emitter.onModels('postMutation', ['Person'], participant);

      try {
        const { result } = await execute(`mutation {
          a: createPerson(input: { name: "opscope-abort-participant", emailAddress: "opscope-participant@example.com" }) { id }
        }`);

        expect(result.errors?.some(e => /participant failure/.test(e.message))).toBe(true);
        expect(await rowsByEmail('opscope-participant@example.com')).toHaveLength(0); // rolled back
        // The response contract: the error self-describes its phase and durable fate — and a
        // rolled-back write NEVER exposes a result (data that didn't happen is not data).
        expect(result.errors[0].extensions).toMatchObject({ code: 'MUTATION_ERROR', committed: false });
        expect(result.errors[0].extensions.result).toBeUndefined();
      } finally {
        Emitter.removeListener('postMutation', participant);
      }
    });

    test('a response-layer (PostOperationError) failure commits the field\'s write — error surfaces, data stays', async () => {
      const presenterBoom = (event, next) => {
        if (`${event.query.input?.name}` === 'opscope-field-poperr') throw new Error('presenter-boom');
        next();
      };
      Emitter.onModels('preResponse', ['Person'], presenterBoom);

      try {
        const { result } = await execute(`mutation {
          a: createPerson(input: { name: "opscope-field-poperr", emailAddress: "opscope-field-poperr@example.com" }) { id }
        }`);

        expect(result.errors?.some(e => /presenter-boom/.test(e.message))).toBe(true);
        expect(await rowsByEmail('opscope-field-poperr@example.com')).toHaveLength(1); // committed
        // Parity with the agMutation caller: same two facts (phase + fate), each side's own
        // channel. Deliberately NO raw result on the wire — response payloads only ever flow
        // through GraphQL completion (selection sets, custom resolvers, crud visibility).
        expect(result.errors[0].extensions).toMatchObject({ code: 'POST_OPERATION_ERROR', committed: true });
        expect(result.errors[0].extensions.result).toBeUndefined();
      } finally {
        Emitter.removeListener('preResponse', presenterBoom);
        await cleanupByEmail('opscope-field-poperr@example.com');
      }
    });

    test('multi-field WITHOUT @transaction: fields are independent units — an earlier field\'s write survives a later failure', async () => {
      const { result, requestResolver } = await execute(`mutation {
        a: createPerson(input: { name: "opscope-spec-a", emailAddress: "opscope-spec-a@example.com" }) { id }
        b: createPerson(input: { name: "FAIL-opscope-spec-b", emailAddress: "opscope-spec-b@example.com" }) { id }
      }`);

      expect(result.errors?.some(e => /deliberate-op-failure/.test(e.message))).toBe(true);
      expect(requestResolver.transactionScope).toBeUndefined();
      // failOn throws from preMutation — a pre-write failure, classified as such on the wire.
      expect(result.errors[0].extensions).toMatchObject({ code: 'PRE_OPERATION_ERROR', committed: false });
      // a committed in its own unit — the caller did not ask to couple the fields.
      expect(await rowsByEmail('opscope-spec-a@example.com')).toHaveLength(1);
      await cleanupByEmail('opscope-spec-a@example.com');
    });

    test('each field gets its OWN scope, and postCommit fires per field, at that field\'s commit', async () => {
      const order = [];
      const scopes = [];
      const pm = (event, next) => { order.push('postMutation'); scopes.push(event.resolver); next(); };
      const pc = (event, next) => { order.push('postCommit'); next(); };
      Emitter.onKeys('postMutation', ['createPerson'], pm);
      Emitter.onKeys('postCommit', ['createPerson'], pc);

      try {
        const { result } = await execute(`mutation {
          a: createPerson(input: { name: "opscope-perfield-a", emailAddress: "opscope-perfield-a@example.com" }) { id }
          b: createPerson(input: { name: "opscope-perfield-b", emailAddress: "opscope-perfield-b@example.com" }) { id }
        }`);

        expect(result.errors).toBeUndefined();
        expect(order).toEqual(['postMutation', 'postCommit', 'postMutation', 'postCommit']); // per field
        expect(scopes[0]).not.toBe(scopes[1]); // independent units — distinct clones

        await resolver.match('Person').id(result.data.a.id).delete();
        await resolver.match('Person').id(result.data.b.id).delete();
      } finally {
        Emitter.removeListener('postMutation', pm);
        Emitter.removeListener('postCommit', pc);
      }
    });
  });

  describe('`mutation @transaction { ... }` — the caller escalates the unit of work to the operation', () => {
    test('two root fields commit together as ONE transaction — same scope, sealed before the response returns', async () => {
      const scopes = [];
      const spy = (event, next) => { scopes.push(event.resolver); next(); };
      Emitter.onKeys('postMutation', ['createPerson'], spy);

      try {
        const { result, requestResolver } = await execute(`mutation @transaction {
          a: createPerson(input: { name: "opscope-both-a", emailAddress: "opscope-both-a@example.com" }) { id }
          b: createPerson(input: { name: "opscope-both-b", emailAddress: "opscope-both-b@example.com" }) { id }
        }`);

        expect(result.errors).toBeUndefined();
        expect(requestResolver.transactionScope).toBeUndefined(); // still never scoped in place
        expect(scopes[0]).toBe(scopes[1]); // ONE shared clone across the fields
        expect(scopes[0].transactionScope.state).toBe('committed');
        expect(await resolver.match('Person').id(result.data.a.id).one()).not.toBeNull();
        expect(await resolver.match('Person').id(result.data.b.id).one()).not.toBeNull();

        await resolver.match('Person').id(result.data.a.id).delete();
        await resolver.match('Person').id(result.data.b.id).delete();
      } finally {
        Emitter.removeListener('postMutation', spy);
      }
    });

    test('all-or-nothing: a real failure on the second field rolls back the first field\'s already-executed write', async () => {
      const { result } = await execute(`mutation @transaction {
        a: createPerson(input: { name: "opscope-atomic-a", emailAddress: "opscope-atomic-a@example.com" }) { id }
        b: createPerson(input: { name: "FAIL-opscope-atomic-b", emailAddress: "opscope-atomic-b@example.com" }) { id }
      }`);

      expect(result.errors?.some(e => /deliberate-op-failure/.test(e.message))).toBe(true);
      // Field a EXECUTED (its write succeeded, inside the hoist) before b failed — but the
      // database must not have it, and neither may the response: the hoist retracts a's recorded
      // success at rollback, so a's replay THROWS (with the cause embedded) instead of
      // materializing a rolled-back payload. Under non-null fields the executor abandons at a,
      // so the one surfaced error sits at a's path, classified as the retraction it is.
      expect(result.data).toBeNull();
      expect(result.errors[0].path).toEqual(['a']);
      expect(result.errors[0].extensions).toMatchObject({ code: 'OPERATION_ABORTED', committed: false });
      expect(await rowsByEmail('opscope-atomic-a@example.com')).toHaveLength(0);
    });

    test('a single-field @transaction operation is identical to the default per-field unit', async () => {
      const { result, requestResolver } = await execute(`mutation @transaction {
        a: createPerson(input: { name: "opscope-single-txn", emailAddress: "opscope-single-txn@example.com" }) { id }
      }`);

      expect(result.errors).toBeUndefined();
      expect(requestResolver.transactionScope).toBeUndefined();
      expect(await resolver.match('Person').id(result.data.a.id).one()).not.toBeNull();
      await resolver.match('Person').id(result.data.a.id).delete();
    });

    test('re-executing the SAME parsed document through the SAME resolver starts a fresh unit', async () => {
      // Apollo caches parsed documents — the same operation AST re-executes across requests, and
      // a script may re-run one document through one resolver. The completed hoist must not bleed
      // into the new execution: "first live selection + completed hoist" can only mean a fresh
      // serial execution (a replay never re-arrives at the first field after completion).
      const contextValue = { network: { id: 'networkId' } };
      const requestResolver = new Resolver({ schema: $schema, context: contextValue });
      expect(requestResolver).toBeDefined();
      const document = parse(`mutation ($i1: PersonInputCreate!, $i2: PersonInputCreate!) @transaction {
        a: createPerson(input: $i1) { id }
        b: createPerson(input: $i2) { id }
      }`);
      const run = n => executeDocument({
        schema: xschema,
        document,
        contextValue,
        variableValues: {
          i1: { name: `opscope-rerun-${n}a`, emailAddress: `opscope-rerun-${n}a@example.com` },
          i2: { name: `opscope-rerun-${n}b`, emailAddress: `opscope-rerun-${n}b@example.com` },
        },
      });

      const emails = ['opscope-rerun-1a@example.com', 'opscope-rerun-1b@example.com', 'opscope-rerun-2a@example.com', 'opscope-rerun-2b@example.com'];
      try {
        const r1 = await run(1);
        const r2 = await run(2); // same AST, same resolver — a fresh unit, not a stale replay
        expect(r1.errors).toBeUndefined();
        expect(r2.errors).toBeUndefined();
        expect(r2.data.a.id).not.toBe(r1.data.a.id);
        expect(await rowsByEmail('opscope-rerun-2b@example.com')).toHaveLength(1);
      } finally {
        await cleanupByEmail(...emails);
      }
    });

    test('a direct (schema-less) invocation cannot hoist — it degrades to independent per-field units', async () => {
      // Nothing to coerce sibling arguments with and no `data` tree to keep honest: a script
      // invoking the wrapped resolver directly with a fabricated `info` gets the default
      // per-field behavior, not a broken half-hoist.
      const { Mutation } = $schema.toObject().resolvers;
      const contextValue = { network: { id: 'networkId' } };
      const requestResolver = new Resolver({ schema: $schema, context: contextValue });
      expect(requestResolver).toBeDefined();
      const operation = parse('mutation @transaction { a: createPerson b: createPerson }').definitions[0];
      const call = (key, input) => Mutation.createPerson(undefined, { input }, contextValue, { operation, fragments: {}, variableValues: {}, path: { key } });

      try {
        await call('a', { name: 'opscope-direct-a', emailAddress: 'opscope-direct-a@example.com' });
        await expect(call('b', { name: 'FAIL-opscope-direct-b', emailAddress: 'opscope-direct-b@example.com' })).rejects.toThrow('deliberate-op-failure');
        // Independent units: a committed on its own, b rolled back on its own.
        expect(await rowsByEmail('opscope-direct-a@example.com')).toHaveLength(1);
        expect(await rowsByEmail('opscope-direct-b@example.com')).toHaveLength(0);
      } finally {
        await cleanupByEmail('opscope-direct-a@example.com', 'opscope-direct-b@example.com');
      }
    });

    const presenterBoomFor = name => (event, next) => {
      if (`${event.query.input?.name}` === name) throw new Error('presenter-boom');
      next();
    };

    test('a mid-operation response-layer failure no longer aborts — the hoist completes and commits the whole unit', async () => {
      // Pre-hoist, this was the hazard case: a's non-null PostOperationError made the executor
      // abandon serial execution before the designated committer could run, forcing a rollback of
      // a COMPLETE-so-far unit. The hoist executes everything before the executor materializes
      // anything, so executor abandonment can no longer amputate the unit: a's data was complete
      // (only its presentation broke), b executes, the unit commits.
      const presenterBoom = presenterBoomFor('opscope-nn-poperr-a');
      Emitter.onModels('preResponse', ['Person'], presenterBoom);

      try {
        const { result } = await execute(`mutation @transaction {
          a: createPerson(input: { name: "opscope-nn-poperr-a", emailAddress: "opscope-nn-poperr-a@example.com" }) { id }
          b: createPerson(input: { name: "opscope-nn-poperr-b", emailAddress: "opscope-nn-poperr-b@example.com" }) { id }
        }`);

        const err = result.errors.find(e => e.path?.[0] === 'a');
        expect(err).toBeDefined();
        expect(err.extensions).toMatchObject({ code: 'POST_OPERATION_ERROR', committed: true });
        expect(await rowsByEmail('opscope-nn-poperr-a@example.com')).toHaveLength(1); // committed
        expect(await rowsByEmail('opscope-nn-poperr-b@example.com')).toHaveLength(1); // committed
      } finally {
        Emitter.removeListener('preResponse', presenterBoom);
        await cleanupByEmail('opscope-nn-poperr-a@example.com', 'opscope-nn-poperr-b@example.com');
      }
    });

    test('a response-layer failure on the LAST field commits — and the earlier field still presents its durable result', async () => {
      const presenterBoom = presenterBoomFor('opscope-nn-last-b');
      Emitter.onModels('preResponse', ['Person'], presenterBoom);

      try {
        const { result } = await execute(`mutation @transaction {
          a: createPerson(input: { name: "opscope-nn-last-a", emailAddress: "opscope-nn-last-a@example.com" }) { id }
          b: createPerson(input: { name: "opscope-nn-last-b", emailAddress: "opscope-nn-last-b@example.com" }) { id }
        }`);

        const err = result.errors.find(e => e.path?.[0] === 'b');
        expect(err).toBeDefined();
        // Every field executed; only b's presentation broke — both writes are durable. NO raw
        // result rides the error (payloads only flow through completion); b is refetchable.
        expect(err.extensions).toMatchObject({ code: 'POST_OPERATION_ERROR', committed: true });
        expect(err.extensions.result).toBeUndefined();
        expect(await rowsByEmail('opscope-nn-last-a@example.com')).toHaveLength(1);
        expect(await rowsByEmail('opscope-nn-last-b@example.com')).toHaveLength(1);
      } finally {
        Emitter.removeListener('preResponse', presenterBoom);
        await cleanupByEmail('opscope-nn-last-a@example.com', 'opscope-nn-last-b@example.com');
      }
    });

    test('postCommit defers to the OPERATION\'s commit — after every field\'s postMutation', async () => {
      const order = [];
      const pm = (event, next) => { order.push('postMutation'); next(); };
      const pc = (event, next) => { order.push('postCommit'); next(); };
      Emitter.onKeys('postMutation', ['createPerson'], pm);
      Emitter.onKeys('postCommit', ['createPerson'], pc);

      try {
        const { result } = await execute(`mutation @transaction {
          a: createPerson(input: { name: "opscope-order-a", emailAddress: "opscope-order-a@example.com" }) { id }
          b: createPerson(input: { name: "opscope-order-b", emailAddress: "opscope-order-b@example.com" }) { id }
        }`);

        expect(result.errors).toBeUndefined();
        // Both postMutations run inside the unit; both postCommits fire only at the operation's
        // single true commit — never interleaved per field (contrast with the default mode).
        expect(order).toEqual(['postMutation', 'postMutation', 'postCommit', 'postCommit']);

        await resolver.match('Person').id(result.data.a.id).delete();
        await resolver.match('Person').id(result.data.b.id).delete();
      } finally {
        Emitter.removeListener('postMutation', pm);
        Emitter.removeListener('postCommit', pc);
      }
    });

    describe('NULLABLE custom mutations — the hoist keeps the response honest regardless of nullability', () => {
      // Custom user-defined root mutations returning nullable types are the shape the pre-hoist
      // design had to reject (INVALID_TRANSACTION): with nullable fields there is no null
      // propagation to retract a rolled-back sibling payload from `data`. The hoist removes the
      // hazard at the root — nothing materializes until the unit's fate is sealed — so nullable
      // fields now get the BEST response shape: a per-field ledger on commit, and per-field
      // errors (never a stale payload) on rollback.
      const buildNullableSchema = () => {
        const captured = {}; // what field b's resolver received when invoked via the hoist
        const wrapped = wrapOperationScope({
          Mutation: {
            a: async (doc, args, context) => {
              const person = await context.autograph.resolver.match('Person').save({ name: args.name, emailAddress: args.email });
              return `${person.id}`;
            },
            b: async (doc, args, context, info) => {
              Object.assign(captured, { args, fieldName: info.fieldName, pathKey: info.path?.key, returnType: `${info.returnType}` });
              const person = await context.autograph.resolver.match('Person').save({ name: args.name, emailAddress: args.email });
              return `${person.id}`;
            },
            // The `.resolve(info)` pattern: return shape driven by connection-detection against
            // `info.returnType` (getGQLReturnType string-matches `.+Connection!?$`).
            c: (doc, args, context, info) => context.autograph.resolver.match('Person').where({ emailAddress: args.email }).resolve(info),
          },
        }, 'autograph');
        const schema = makeExecutableSchema({
          typeDefs: `directive @transaction on MUTATION
            type Query { ping: String }
            type FakeConnection { count: Int }
            type Mutation {
              a(name: String!, email: String!): String
              b(name: String!, email: String!): String
              c(email: String!): FakeConnection
            }`,
          resolvers: wrapped,
        });
        return { schema, captured };
      };
      const source = `mutation ($an: String!, $ae: String!, $bn: String!, $be: String!) @transaction {
        a(name: $an, email: $ae)
        b(name: $bn, email: $be)
      }`;

      test('commit: a per-field ledger — every data slot presents its real durable result; hoisted siblings receive faithful args/info', async () => {
        const { schema, captured } = buildNullableSchema();
        const contextValue = { network: { id: 'networkId' } };
        const requestResolver = new Resolver({ schema: $schema, context: contextValue });
        expect(requestResolver).toBeDefined();

        try {
          const result = await graphql({
            schema,
            contextValue,
            source,
            variableValues: { an: 'opscope-grail-a', ae: 'opscope-grail-a@example.com', bn: 'opscope-grail-b', be: 'opscope-grail-b@example.com' },
          });

          expect(result.errors).toBeUndefined();
          expect(result.data.a).toEqual(expect.any(String)); // per-field ledger: both slots real
          expect(result.data.b).toEqual(expect.any(String));
          expect(await rowsByEmail('opscope-grail-a@example.com')).toHaveLength(1);
          expect(await rowsByEmail('opscope-grail-b@example.com')).toHaveLength(1);
          // The hoisted (fabricated-info) invocation of b: args coerced from the document AST +
          // variables by graphql's own coercion; info carries b's own identity.
          expect(captured.args).toEqual({ name: 'opscope-grail-b', email: 'opscope-grail-b@example.com' });
          expect(captured.fieldName).toBe('b');
          expect(captured.pathKey).toBe('b');
          expect(captured.returnType).toBe('String');
        } finally {
          await cleanupByEmail('opscope-grail-a@example.com', 'opscope-grail-b@example.com');
        }
      });

      test('a custom resolver returning `.resolve(info)` keeps its connection detection under the hoist', async () => {
        // The `.resolve(info)` return shape is decided by string-matching `info.returnType` —
        // the fabricated sibling info carries the schema's real field type, so a Connection
        // return resolves to the { count, edges, pageInfo } thunk shape, and the thunks execute
        // during completion (post-commit) as settled-scope reads of committed state.
        const { schema } = buildNullableSchema();
        const contextValue = { network: { id: 'networkId' } };
        const requestResolver = new Resolver({ schema: $schema, context: contextValue });
        expect(requestResolver).toBeDefined();

        try {
          const result = await graphql({
            schema,
            contextValue,
            source: `mutation ($an: String!, $ae: String!) @transaction {
              a(name: $an, email: $ae)
              c(email: $ae) { count }
            }`,
            variableValues: { an: 'opscope-conn', ae: 'opscope-conn@example.com' },
          });

          expect(result.errors).toBeUndefined();
          expect(result.data.a).toEqual(expect.any(String));
          expect(result.data.c).toEqual({ count: 1 }); // connection shape detected; committed read
        } finally {
          await cleanupByEmail('opscope-conn@example.com');
        }
      });

      test('rollback: EVERY data slot is null + a self-describing error — a rolled-back payload can never appear', async () => {
        const { schema } = buildNullableSchema();
        const contextValue = { network: { id: 'networkId' } };
        const requestResolver = new Resolver({ schema: $schema, context: contextValue });
        expect(requestResolver).toBeDefined();

        const result = await graphql({
          schema,
          contextValue,
          source,
          variableValues: { an: 'opscope-grail-rb-a', ae: 'opscope-grail-rb-a@example.com', bn: 'FAIL-opscope-grail-rb-b', be: 'opscope-grail-rb-b@example.com' },
        });

        // a EXECUTED inside the hoist (its write succeeded) before b failed — with nullable
        // fields and no hoist, a's payload would sit in `data` as a rolled-back lie. Instead:
        // fate was sealed before materialization, so a's slot errors alongside b's.
        expect(result.data).toEqual({ a: null, b: null });
        const errA = result.errors.find(e => e.path?.[0] === 'a');
        const errB = result.errors.find(e => e.path?.[0] === 'b');
        expect(errA.extensions).toMatchObject({ code: 'OPERATION_ABORTED', committed: false });
        expect(errA.message).toMatch(/deliberate-op-failure/); // the cause, embedded
        expect(errB.extensions).toMatchObject({ code: 'PRE_OPERATION_ERROR', committed: false });
        expect(await rowsByEmail('opscope-grail-rb-a@example.com')).toHaveLength(0);
        expect(await rowsByEmail('opscope-grail-rb-b@example.com')).toHaveLength(0);
      });
    });

    test('field merging: the same response key selected twice executes ONCE, with merged selections', async () => {
      // Valid GraphQL: same field + identical args selected twice (validation enforces the args
      // match); the executor invokes the resolver once with both fieldNodes merged. The hoist
      // must dedupe by response key or the write would run twice.
      const { result } = await execute(`mutation @transaction {
        createPerson(input: { name: "opscope-merge", emailAddress: "opscope-merge@example.com" }) { id }
        createPerson(input: { name: "opscope-merge", emailAddress: "opscope-merge@example.com" }) { emailAddress }
      }`);

      try {
        expect(result.errors).toBeUndefined();
        expect(result.data.createPerson.id).toBeDefined(); // merged selection set: both
        expect(result.data.createPerson.emailAddress).toBe('opscope-merge@example.com');
        expect(await rowsByEmail('opscope-merge@example.com')).toHaveLength(1); // ONE write
      } finally {
        await cleanupByEmail('opscope-merge@example.com');
      }
    });

    test('@skip/@include: a skipped selection is not part of the hoisted unit', async () => {
      // 3 selections, the FINAL one @skip'd away → the hoist must execute exactly the live
      // fields (a, b), commit them, and never run c's body.
      const { result } = await execute(`mutation ($skipC: Boolean!) @transaction {
        a: createPerson(input: { name: "opscope-directive-a", emailAddress: "opscope-directive-a@example.com" }) { id }
        b: createPerson(input: { name: "opscope-directive-b", emailAddress: "opscope-directive-b@example.com" }) { id }
        c: createPerson(input: { name: "opscope-directive-c", emailAddress: "opscope-directive-c@example.com" }) @skip(if: $skipC) { id }
      }`, { skipC: true });

      expect(result.errors).toBeUndefined();
      expect(result.data.c).toBeUndefined(); // skipped, never counted, never awaited
      // b (the last LIVE selection) was the designated committer — both live writes committed.
      expect(await resolver.match('Person').id(result.data.a.id).one()).not.toBeNull();
      expect(await resolver.match('Person').id(result.data.b.id).one()).not.toBeNull();

      await resolver.match('Person').id(result.data.a.id).delete();
      await resolver.match('Person').id(result.data.b.id).delete();
    });
  });

  test('an already-open host-managed scope makes the wrapper stand down — the host closes what the host opened', async () => {
    const contextValue = { network: { id: 'networkId' } };
    const requestResolver = new Resolver({ schema: $schema, context: contextValue }).transaction({ isolated: false });
    const hostScope = requestResolver.transactionScope;

    const result = await graphql({
      schema: xschema,
      contextValue,
      source: `mutation @transaction {
        a: createPerson(input: { name: "opscope-host-a", emailAddress: "opscope-host-a@example.com" }) { id }
        b: createPerson(input: { name: "opscope-host-b", emailAddress: "opscope-host-b@example.com" }) { id }
      }`,
    });

    expect(result.errors).toBeUndefined();
    expect(requestResolver.transactionScope).toBe(hostScope); // untouched
    expect(hostScope.state).toBe('open'); // the wrapper did NOT commit it
    await requestResolver.rollback(); // the host decides — roll it all back

    expect(await resolver.match('Person').id(result.data.a.id).one()).toBeNull();
    expect(await resolver.match('Person').id(result.data.b.id).one()).toBeNull();
  });
});
