const get = require('lodash.get');
const ObjectId = require('bson-objectid');
const Util = require('@coderich/util');
const Emitter = require('../../src/data/Emitter');

describe('Resolver', () => {
  let schema, resolver, context, query, event, $event, person;

  // Dynamic Jest Matching
  const mocks = {};
  const hooks = ['preQuery', 'postQuery', 'preMutation', 'postMutation', 'finalize', 'preResponse', 'postResponse'];
  const matcher = expect.multiplex(
    val => expect(val).toMatchObject({ schema, resolver, context, query: event }),
    (e) => {
      Object.entries(Util.flatten($event)).forEach(([key, value]) => {
        try {
          expect(get(e, key)).toEqual(value);
        } catch ({ message }) {
          console.log(key, e, value);
          throw new Error(message);
        }
      });
    },
  );
  const asserter = (eventNames, calledTimes, doMatch = true) => {
    event = { ...query };
    if (event.input) event.input = expect.objectContaining(event.input);
    event = expect.objectContaining(event);

    eventNames.forEach((hook) => {
      const [basicFunc, nextFunc] = [mocks[hook], mocks[`${hook}Next`]];
      expect(basicFunc).toHaveBeenCalledTimes(calledTimes);
      if (calledTimes && doMatch) expect(basicFunc).toHaveBeenCalledWith(matcher);
      if (nextFunc) expect(nextFunc).toHaveBeenCalledTimes(calledTimes);
      if (nextFunc && calledTimes && doMatch) expect(nextFunc).toHaveBeenCalledWith(matcher, expect.any(Function));
    });
  };

  beforeAll(() => {
    ({ schema, resolver, context } = global);
    Emitter.cloneData = true;
  });

  afterAll(() => {
    delete Emitter.cloneData;
  });

  beforeEach(() => {
    query = event = {};

    $event = {
      'query.doc': undefined,
      'query.result': undefined,
      'query.args.input.id': undefined,
      'query.args.input.updatedAt': undefined,
      'query.args.input.createdAt': undefined,
    };

    // Create mock functions
    hooks.forEach((eventName, i) => {
      mocks[eventName] = jest.fn((e) => {});
      mocks[`${eventName}Next`] = jest.fn((e, next) => next());
      Emitter.on(eventName, mocks[eventName]);
      Emitter.on(eventName, mocks[`${eventName}Next`]);
    });
  });

  afterEach(() => {
    Emitter.removeAllListeners();
  });

  describe('System Events', () => {
    test('create', async () => {
      query = { model: 'Person', op: 'createOne', key: 'createPerson', crud: 'create', isMutation: true };
      query.args = { input: { name: 'Rich', emailAddress: 'email@gmail.com' }, meta: { id: 1 } };
      query.input = { id: expect.thunk(ObjectId.isValid), name: 'rich', emailAddress: 'email@gmail.com', telephone: '###-###-####' };
      $event['args.input.telephone'] = undefined; // Test that defaultValue is not applied here

      // Create person
      person = await resolver.match('Person').meta({ id: 1 }).save(query.args.input);

      // No Query hooks should have been called
      asserter(['preQuery', 'postQuery'], 0);

      // Pre Mutation + finalize
      asserter(['preMutation', 'finalize'], 1);

      // Post Mutation + Responses
      query.input.createdAt = query.input.updatedAt = expect.any(Date);
      $event['query.result'] = person; // There is only a result (no doc on create)
      asserter(['postMutation', 'preResponse', 'postResponse'], 1);
    });

    test('update', async () => {
      // Update person
      const updatedPerson = await resolver.match('Person').id(person.id).save({ age: 45 });

      // Pre Query (this comes from internal #get lookup)
      query = { id: person.id, model: 'Person', op: 'findOne', key: 'getPerson', crud: 'read' };
      query.args = { id: person.id };
      query.where = { id: person.id, network: 'networkId' };
      asserter(['preQuery'], 1);

      // Post Query
      $event['query.result'] = person;
      asserter(['postQuery'], 1);

      // Pre Mutation + finalize
      query = { id: person.id, model: 'Person', op: 'updateOne', key: 'updatePerson', crud: 'update', isMutation: true };
      query.args = { id: person.id, input: { age: 45 } };
      query.input = { age: 45 };
      // query.changeset = { added: { age: 45 }, updated: {}, deleted: {} };
      $event['query.doc'] = person;
      $event['query.result'] = undefined;
      asserter(['preMutation', 'finalize'], 1);

      // Post Mutation + Responses
      $event['query.result'] = updatedPerson;
      asserter(['postMutation'], 1);

      // Response
      asserter(['preResponse', 'postResponse'], 2, false); // Once for Query once for Mutation!

      person = updatedPerson;
    });

    test('update with no changes', async () => {
      // Saving name (but should be no change)
      await resolver.match('Person').id(person.id).save({ name: 'Rich' });
      asserter(['preQuery'], 1);

      $event['query.result'] = person;
      asserter(['postQuery'], 1);

      $event['query.doc'] = person;
      $event['query.result'] = undefined;
      asserter(['preMutation'], 1);

      asserter(['postMutation'], 0); // Not called! (no data changes)
    });

    test('hijack query output', async () => {
      Emitter.cloneData = false; // The default, we can't clone otherwise we lose reference!
      Emitter.on({ event: 'preQuery', model: 'Person', crud: 'r', once: true }, () => ({ id: 1, name: 'hijacked' }));
      expect(await resolver.match('Person').where({ name: 'rich' }).one()).toEqual({ id: 1, name: 'hijacked' });
      expect(await resolver.match('Person').where({ name: 'rich' }).one()).toEqual(person);
      Emitter.on({ event: 'preQuery', model: 'Person', crud: 'r', once: true }, (e, next) => next({ id: 1, name: 'hijacked again' }));
      expect(await resolver.match('Person').where({ name: 'rich' }).one()).toEqual({ id: 1, name: 'hijacked again' });
      expect(await resolver.match('Person').where({ name: 'rich' }).one()).toEqual(person);
    });

    test('hijack mutation output', async () => {
      Emitter.cloneData = false; // The default, we can't clone otherwise we lose reference!
      Emitter.on({ event: 'preMutation', model: 'Person', crud: 'u', once: true }, () => ({ id: 1, name: 'hijacked' }));
      expect(await resolver.match('Person').where({ name: 'rich' }).save({ age: 60 })).toEqual([{ id: 1, name: 'hijacked' }]);
      Emitter.on({ event: 'preMutation', model: 'Person', crud: 'u', once: true }, (e, next) => next({ id: 1, name: 'hijacked again' }));
      expect(await resolver.match('Person').where({ name: 'rich' }).save({ age: 60 })).toEqual([{ id: 1, name: 'hijacked again' }]);
      expect(await resolver.match('Person').where({ name: 'rich' }).one()).toEqual(person);
    });

    test('hijack where clause', async () => {
      let counter = 0;
      Emitter.cloneData = false; // The default, we can't clone otherwise we lose reference!
      expect(await resolver.match('Person').where({ name: '$magic' }).one()).toBeNull();
      Emitter.on({ event: 'preQuery', model: 'Person', crud: 'r' }, (ev) => {
        if (ev.query.args.where.name === '$magic' && counter++) ev.query.where = { name: 'rich' };
      });
      expect(await resolver.match('Person').where({ name: '$magic' }).one()).toBeNull();
      expect(await resolver.match('Person').where({ name: '$magic' }).one()).not.toBeNull();
    });

    test('hijack input', async () => {
      Emitter.cloneData = false; // The default, we can't clone otherwise we lose reference!
      Emitter.on({ event: 'preMutation', model: 'Person', crud: 'u' }, (ev) => { ev.query.input.age = 45; });
      expect(await resolver.match('Person').id(person.id).save({ age: 65 })).toEqual(person); // Because we clobbered all input transformations!
    });
  });
});
