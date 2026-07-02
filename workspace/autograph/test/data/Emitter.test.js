const EventEmitter = require('node:events');
const Emitter = require('../../src/data/Emitter');

class MyEmitter extends EventEmitter {
  emit(event, data) {
    const [wrapper] = this.rawListeners(event);
    return (wrapper.listener || wrapper).length;
  }
}

describe('Emitter', () => {
  let resolver;

  beforeAll(async () => {
    ({ resolver } = global);
  });

  test('EventEmitter internals', () => {
    const e = new MyEmitter();
    e.once('zero', () => {});
    e.once('one', (one) => {});
    e.once('two', (one, two) => {});
    expect(e.emit('zero', {})).toBe(0);
    expect(e.emit('one', {})).toBe(1);
    expect(e.emit('two', {})).toBe(2);
  });

  describe('Basics', () => {
    test('on', () => {
      const fn = jest.fn();
      Emitter.on('on', fn);
      Emitter.emit('on');
      Emitter.emit('on');
      expect(fn).toBeCalledTimes(2);
    });

    test('once', () => {
      const fn = jest.fn();
      Emitter.once('once', fn);
      Emitter.emit('once');
      Emitter.emit('once');
      expect(fn).toBeCalledTimes(1);
    });

    test('onKeys', () => {
      const fn = jest.fn();
      Emitter.onKeys('onKeys', 'key', fn);
      Emitter.emit('onKeys', { query: { key: 'key' } });
      Emitter.emit('onKeys', { query: { key: 'miss' } });
      Emitter.emit('onKeys', { query: { key: 'key' } });
      setImmediate(() => {
        expect(fn).toBeCalledTimes(2);
      });
    });

    test('onceKeys', () => {
      const fn = jest.fn();
      Emitter.onceKeys('onceKeys', 'key', fn);
      Emitter.emit('onceKeys', { query: { key: 'miss' } }); // Keep this miss first in the test
      Emitter.emit('onceKeys', { query: { key: 'key' } });
      Emitter.emit('onceKeys', { query: { key: 'key' } });
      setImmediate(() => {
        expect(fn).toBeCalledTimes(1);
      });
    });

    test('onModels', () => {
      const fn = jest.fn();
      Emitter.onModels('onModels', 'key', fn);
      Emitter.emit('onModels', { query: { model: 'key' } });
      Emitter.emit('onModels', { query: { model: 'miss' } });
      Emitter.emit('onModels', { query: { model: 'key' } });
      expect(fn).toBeCalledTimes(2);
    });

    test('onceModels', () => {
      const fn = jest.fn();
      Emitter.onceModels('onceModels', 'key', fn);
      Emitter.emit('onceModels', { query: { model: 'miss' } }); // Keep this miss first in the test
      Emitter.emit('onceModels', { query: { model: 'key' } });
      Emitter.emit('onceModels', { query: { model: 'key' } });
      expect(fn).toBeCalledTimes(1);
    });

    test('order', async () => {
      const fn1 = jest.fn();
      const fn2 = jest.fn((event, next) => next());
      const fn3 = jest.fn();
      Emitter.on('order', fn1);
      Emitter.on('order', fn2);
      Emitter.on('order', fn3);
      await Emitter.emit('order');
      const [[order1], [order2], [order3]] = [fn1.mock.invocationCallOrder, fn2.mock.invocationCallOrder, fn3.mock.invocationCallOrder];
      expect(order1).toBeLessThan(order2);
      expect(order1).toBeLessThan(order3);
      expect(order2).toBeGreaterThan(order1);
      expect(order2).toBeGreaterThan(order3);
      expect(order3).toBeGreaterThan(order1);
      expect(order3).toBeLessThan(order2);
    });
  });

  describe('Event mutations', () => {
    test('preMutation', (done) => {
      Emitter.onceModels('preMutation', ['Person'], (event, next) => {
        // Proving that embedded/mixed values make it to event.query.input...
        expect(event.query.input.sections).toEqual([expect.objectContaining({
          name: 'section', // Lowercase
          mixed: { name: { en: 'Richard' } },
        })]);

        // Mutations
        event.query.input.name = 'rich';
        event.query.input.emailAddress = 'rich@rich.com';
        next();
      });

      Emitter.onceModels('postMutation', ['Person'], (event) => {
        expect(event.query.result).toMatchObject({ name: 'rich' });
        done();
      });

      resolver.match('Person').save({
        sections: { name: 'Section', 'mixed.name.en': 'Richard' },
      }).catch((e) => {
        done(e);
      });
    });

    test('validate', (done) => {
      Emitter.onceModels('validate', ['Person'], (event, next) => {
        event.query.input.age = 40;
        next();
      });

      Emitter.onceModels('postMutation', ['Person'], (event) => {
        expect(event.query.result).toMatchObject({
          age: 40,
          name: 'rich2',
          emailAddress: 'rich@rich.com',
        });
        done();
      });

      resolver.match('Person').save({ name: 'rich2', emailAddress: 'rich@rich.com' }).catch((e) => {
        done(e);
      });
    });
  });

  describe('Early return', () => {
    test('basic abort', async () => {
      const fn1 = jest.fn(() => ({ abort: 'abort' }));
      const fn2 = jest.fn();
      const fn3 = jest.fn((event, next) => next());
      Emitter.onKeys('basicAbort', 'key', fn1);
      Emitter.on('basicAbort', fn2);
      Emitter.on('basicAbort', fn3);
      const value = await Emitter.emit('basicAbort', { query: { key: 'key' } });
      expect(fn1).toBeCalledTimes(1);
      expect(fn2).toBeCalledTimes(0);
      expect(fn3).toBeCalledTimes(0);
      expect(value).toEqual({ abort: 'abort' });
    });

    test('basic (with async keyword) abort', async () => {
      const fn1 = jest.fn(async () => undefined);
      const fn2 = jest.fn();
      const fn3 = jest.fn((event, next) => next());
      Emitter.on('basicAsync', fn3);
      Emitter.on('basicAsync', fn1);
      Emitter.on('basicAsync', fn2);
      const value = await Emitter.emit('basicAsync');
      expect(fn1).toBeCalledTimes(1);
      expect(fn2).toBeCalledTimes(1);
      expect(fn3).toBeCalledTimes(1);
      expect(value).toBeUndefined();
    });

    test('basic throw', async () => {
      const fn1 = jest.fn(() => { throw new Error('bad'); });
      const fn2 = jest.fn();
      const fn3 = jest.fn((event, next) => next());
      Emitter.on('basicThrow', fn3);
      Emitter.on('basicThrow', fn1);
      Emitter.on('basicThrow', fn2);
      await expect(Emitter.emit('basicThrow')).rejects.toThrow('bad');
      expect(fn1).toThrow('bad');
      expect(fn2).toBeCalledTimes(0);
      expect(fn3).toBeCalledTimes(0);
    });

    test('parallel nexts (the first to resolve wins)...', async () => {
      const fn1 = jest.fn((event, next) => setImmediate(() => next({ abort: 'abort1' })));
      const fn2 = jest.fn((event, next) => next({ abort: 'abort2' }));
      const fn3 = jest.fn();
      Emitter.on('parallelNextRace', fn3);
      Emitter.on('parallelNextRace', fn1);
      Emitter.on('parallelNextRace', fn2);
      const value = await Emitter.emit('parallelNextRace');
      expect(fn1).toBeCalledTimes(1);
      expect(fn2).toBeCalledTimes(1);
      expect(fn3).toBeCalledTimes(1);
      expect(value).toEqual({ abort: 'abort2' });
    });

    test('next throw', async () => {
      const fn1 = jest.fn((event, next) => { throw new Error('very bad'); });
      const fn2 = jest.fn((event, next) => next());
      const fn3 = jest.fn();
      Emitter.on('nextThrow', fn1);
      Emitter.on('nextThrow', fn2);
      Emitter.on('nextThrow', fn3);
      await expect(Emitter.emit('nextThrow')).rejects.toThrow('very bad');
      expect(fn1).toThrow('very bad');
      expect(fn2).toBeCalledTimes(1);
      expect(fn3).toBeCalledTimes(1);
    });
  });

  describe('Priority', () => {
    // Base case
    const fn1 = jest.fn();
    const fn2 = jest.fn();
    const fn3 = jest.fn();
    Emitter.on('event', fn1);
    Emitter.on('event', fn2);
    Emitter.prependListener('event', fn3);
    Emitter.emit('event');
    expect(fn1.mock.invocationCallOrder[0]).toBeLessThan(fn2.mock.invocationCallOrder[0]);
    expect(fn3.mock.invocationCallOrder[0]).toBeLessThan(fn1.mock.invocationCallOrder[0]);

    // Priority
    const fn11 = jest.fn();
    const fn21 = jest.fn();
    const fn31 = jest.fn();
    Emitter.on('event', fn11);
    Emitter.prependListener('event', fn31, { priority: -Infinity });
    Emitter.on('event', fn21, { priority: 1 });
    Emitter.emit('event');
    expect(fn21.mock.invocationCallOrder[0]).toBeLessThan(fn11.mock.invocationCallOrder[0]);
    expect(fn21.mock.invocationCallOrder[0]).toBeLessThan(fn31.mock.invocationCallOrder[0]);
    expect(fn11.mock.invocationCallOrder[0]).toBeLessThan(fn31.mock.invocationCallOrder[0]);

    // Infinities
    const inf1 = jest.fn();
    const inf2 = jest.fn();
    Emitter.on('event', inf1, { priority: Infinity });
    Emitter.on('event', inf2, { priority: Infinity });
    Emitter.emit('event');
    expect(inf1.mock.invocationCallOrder[0]).toBeLessThan(inf2.mock.invocationCallOrder[0]);
  });

  describe('Memoize', () => {
    test('empty events skip work', async () => {
      // Sanity: emitting an event with no listeners returns a resolved promise without invoking anything
      const result = await Emitter.emit('memoEmpty', { resolver, query: { model: 'X' } });
      expect(result).toBeUndefined();
    });

    test('basic listener fires once per unique query when memoize: true', async () => {
      const fn = jest.fn(() => undefined);
      Emitter.on('memoBasic', fn, { memoize: true });
      const event = { resolver, query: { model: 'M', crud: 'read', op: 'findOne', where: { id: 1 } } };
      await Emitter.emit('memoBasic', event);
      await Emitter.emit('memoBasic', event);
      await Emitter.emit('memoBasic', event);
      expect(fn).toBeCalledTimes(1);

      // Different query key → listener runs again
      await Emitter.emit('memoBasic', { resolver, query: { ...event.query, where: { id: 2 } } });
      expect(fn).toBeCalledTimes(2);
    });

    test('next-style listener memoizes the value passed to next()', async () => {
      const fn = jest.fn((event, next) => next());
      Emitter.on('memoNext', fn, { memoize: true });
      const event = { resolver, query: { model: 'M', crud: 'read', op: 'findOne', where: { id: 1 } } };
      await Emitter.emit('memoNext', event);
      await Emitter.emit('memoNext', event);
      expect(fn).toBeCalledTimes(1);
    });

    test('memoize without resolver is a silent no-op', async () => {
      const fn = jest.fn(() => undefined);
      Emitter.on('memoNoResolver', fn, { memoize: true });
      await Emitter.emit('memoNoResolver', { query: { model: 'M' } });
      await Emitter.emit('memoNoResolver', { query: { model: 'M' } });
      expect(fn).toBeCalledTimes(2); // fires every call because no resolver scope
    });

    test('without memoize: true the listener fires every call', async () => {
      const fn = jest.fn(() => undefined);
      Emitter.on('memoOff', fn);
      const event = { resolver, query: { model: 'M', crud: 'read', op: 'findOne' } };
      await Emitter.emit('memoOff', event);
      await Emitter.emit('memoOff', event);
      expect(fn).toBeCalledTimes(2);
    });
  });

  describe('removeListener on onModels/onKeys registrations (regression)', () => {
    // Bug: #createWrapper (backing onModels/onKeys/onceModels/onceKeys) built its own wrapper
    // closure but never set `.listener` on it — the same convention wrapBasicMemoize/
    // wrapNextMemoize already rely on so `removeListener(event, originalFn)` can find a wrapped
    // listener via `l.listener === listener`. Without it, removeListener could never find or
    // remove a hook registered via onModels/onKeys by its original function reference — the
    // wrapper (and thus the hook) stayed registered forever, regardless of how many times the
    // caller "removed" it.
    test('a basic-style (arity < 2) onModels listener can be removed by its original function reference', async () => {
      const fn = jest.fn(() => undefined);
      Emitter.onModels('removeMeBasic', ['M'], fn);
      Emitter.removeListener('removeMeBasic', fn);
      await Emitter.emit('removeMeBasic', { resolver, query: { model: 'M', crud: 'read', op: 'findOne' } });
      expect(fn).not.toHaveBeenCalled();
    });

    test('a next-style (arity >= 2) onModels listener can be removed by its original function reference', async () => {
      const fn = jest.fn((event, next) => next());
      Emitter.onModels('removeMeNext', ['M'], fn);
      Emitter.removeListener('removeMeNext', fn);
      await Emitter.emit('removeMeNext', { resolver, query: { model: 'M', crud: 'read', op: 'findOne' } });
      expect(fn).not.toHaveBeenCalled();
    });

    test('an onKeys listener can be removed by its original function reference', async () => {
      const fn = jest.fn(() => undefined);
      Emitter.onKeys('removeMeKeys', ['someKey'], fn);
      Emitter.removeListener('removeMeKeys', fn);
      await Emitter.emit('removeMeKeys', { resolver, query: { key: 'someKey', crud: 'read', op: 'findOne' } });
      expect(fn).not.toHaveBeenCalled();
    });
  });
});
