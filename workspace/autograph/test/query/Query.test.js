const ObjectId = require('bson-objectid');
const QueryBuilder = require('../../src/query/QueryBuilder');

describe('Query', () => {
  let schema, factory, resolver;

  beforeAll(() => {
    ({ schema, resolver } = global);
    factory = model => new QueryBuilder({ resolver, schema, query: { model }, context: { network: { id: 'network' } } });
  });

  describe('transform', () => {
    // test('validate (object reference)', async () => {
    //   const query = await factory('Person').save({ name: 'Rich', emailAddress: 'rich@rich.com' }).transform();
    //   const $query = query.toObject();
    //   expect($query.input).toMatchObject({ name: 'rich', emailAddress: 'rich@rich.com' });
    //   expect($query.$thunks).not.toBeDefined();
    //   const q = query.validate();
    //   expect(q.toObject().input).toBe($query.input);
    // });

    test('findOne', async () => {
      expect((await factory('Person').id(1).one().transform()).toObject()).toMatchObject({
        id: 1,
        crud: 'read',
        op: 'findOne',
        key: 'getPerson',
        model: 'Person',
        input: undefined,
        where: {
          id: expect.thunk(ObjectId.isValid),
          network: 'network',
        },
        args: {
          id: 1,
        },
      });
    });

    test('findOne (undefined)', async () => {
      expect((await factory('Person').id(undefined).one().transform()).toObject()).toMatchObject({
        id: undefined,
        crud: 'read',
        op: 'findOne',
        key: 'getPerson',
        model: 'Person',
        input: undefined,
        where: {
          id: undefined,
          network: 'network',
        },
        args: {
          id: undefined,
        },
      });
    });

    test('findMany', async () => {
      expect((await factory('Person').where({ name: 'RICH' }).sort({ age: 'desc' }).many().transform()).toObject()).toMatchObject({
        id: undefined,
        crud: 'read',
        op: 'findMany',
        key: 'findPerson',
        model: 'Person',
        input: undefined,
        where: {
          name: 'rich',
          network: 'network',
        },
        sort: {
          age: 'desc',
        },
        args: {
          where: { name: 'RICH' },
          sort: { age: 'desc' },
        },
      });
    });

    test('updateMany', async () => {
      expect((await factory('Person').where({ name: 'rich' }).save({ name: 'RiChArD', emailAddress: 'rich@gmail.com' }).transform()).toObject()).toMatchObject({
        crud: 'update',
        op: 'updateMany',
        key: 'updatePerson',
        model: 'Person',
        args: {
          where: { name: 'rich' },
          input: { name: 'RiChArD', emailAddress: 'rich@gmail.com' },
        },
        input: {
          id: expect.thunk(ObjectId.isValid),
          name: 'richard',
          network: 'network',
          emailAddress: 'rich@gmail.com',
          updatedAt: expect.any(Date),
        },
      });
    });

    test('createOne', async () => {
      expect((await factory('Person').save({ name: 'RiChArD', emailAddress: 'rich@gmail.com' }).transform()).toObject()).toMatchObject({
        id: undefined,
        crud: 'create',
        op: 'createOne',
        key: 'createPerson',
        model: 'Person',
        args: {
          input: {
            name: 'RiChArD',
            emailAddress: 'rich@gmail.com',
          },
        },
        input: {
          id: expect.thunk(ObjectId.isValid),
          name: 'richard',
          network: 'network',
          emailAddress: 'rich@gmail.com',
          telephone: '###-###-####', // Create will set default input
          updatedAt: expect.any(Date),
          createdAt: expect.any(Date),
        },
      });
    });

    test('createMany', async () => {
      expect((await factory('Person').save({ name: 'RiChArD', emailAddress: 'rich@gmail.com' }, { name: 'another', emailAddress: 'a@notheR.com' }).transform()).toObject()).toMatchObject({
        id: undefined,
        crud: 'create',
        op: 'createMany',
        key: 'createPerson',
        model: 'Person',
        args: {
          input: [
            {
              name: 'RiChArD',
              emailAddress: 'rich@gmail.com',
            },
            {
              name: 'another',
              emailAddress: 'a@notheR.com',
            },
          ],
        },
        input: [
          {
            id: expect.thunk(ObjectId.isValid),
            name: 'richard',
            network: 'network',
            emailAddress: 'rich@gmail.com',
            telephone: '###-###-####', // Create will set default input
            updatedAt: expect.any(Date),
            createdAt: expect.any(Date),
          },
          {
            id: expect.thunk(ObjectId.isValid),
            name: 'another',
            network: 'network',
            emailAddress: 'a@notheR.com',
            telephone: '###-###-####', // Create will set default input
            updatedAt: expect.any(Date),
            createdAt: expect.any(Date),
          },
        ],
      });
    });

    test('deleteOne', async () => {
      expect((await factory('Person').id(1).delete().transform()).toObject()).toMatchObject({
        id: 1,
        crud: 'delete',
        op: 'deleteOne',
        key: 'deletePerson',
        model: 'Person',
        input: undefined,
        args: { id: 1 },
        where: {
          id: expect.thunk(ObjectId.isValid),
          network: 'network',
        },
      });
    });

    test('clone', async () => {
      const query = await factory('Person').id(1).delete().transform();
      expect(query.toObject()).toMatchObject({ input: undefined, args: { id: 1 } });
      const clone = await query.clone({ input: { name: 'rich' } }).transform();
      expect(clone.toObject()).toMatchObject({ input: { name: 'rich' }, args: { id: 1 } });
    });
  });

  describe('toCacheKey (regression)', () => {
    // Bug: DataLoaders are shared across a whole request, including with every isolated
    // transaction cloned from it (see Resolver#clone). Two otherwise-identical reads — one issued
    // with a transaction's session attached (see Resolver#resolve's peekSession use), one without
    // — computed the SAME cache key, so a transactional read's result leaked into the shared
    // front-door DataLoader cache and was returned to a plain, non-transactional read for the same
    // query (and vice versa). Fixed by folding a stable session tag into the cache key.
    test('an otherwise-identical query with a session attached gets a different cache key than one without', async () => {
      // .clone() shares everything except the overridden fields — this isolates the comparison to
      // `options.session` alone. Using three separately-constructed queries here would be a false
      // test: the "id" field's generator produces a fresh, non-deterministic ObjectId suffix per
      // call (it embeds a timestamp + random/counter bytes), which would make the keys differ for
      // a reason that has nothing to do with sessions.
      const base = await factory('Person').id(1).one().transform();
      const keyNoSession = base.toCacheKey();

      const queryA = base.clone({ options: { session: { fake: 'session-a' } } });
      const keySessionA = queryA.toCacheKey();

      const queryB = base.clone({ options: { session: { fake: 'session-b' } } });
      const keySessionB = queryB.toCacheKey();

      expect(keySessionA).not.toBe(keyNoSession);
      expect(keySessionA).not.toBe(keySessionB);
    });
  });
});
