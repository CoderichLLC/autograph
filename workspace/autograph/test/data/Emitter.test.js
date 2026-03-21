const EventEmitter = require('events');
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
        event.query.input.name = 'rich';
        event.query.input.emailAddress = 'rich@rich.com';
        next();
      });

      Emitter.onceModels('postMutation', ['Person'], (event) => {
        expect(event.query.result).toMatchObject({ name: 'rich' });
        done();
      });

      resolver.match('Person').save().catch((e) => {
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
    Emitter.prependListener('event', fn31, -Infinity);
    Emitter.on('event', fn21, 1);
    Emitter.emit('event');
    expect(fn21.mock.invocationCallOrder[0]).toBeLessThan(fn11.mock.invocationCallOrder[0]);
    expect(fn21.mock.invocationCallOrder[0]).toBeLessThan(fn31.mock.invocationCallOrder[0]);
    expect(fn11.mock.invocationCallOrder[0]).toBeLessThan(fn31.mock.invocationCallOrder[0]);

    // Infinities
    const inf1 = jest.fn();
    const inf2 = jest.fn();
    Emitter.on('event', inf1, Infinity);
    Emitter.on('event', inf2, Infinity);
    Emitter.emit('event');
    expect(inf1.mock.invocationCallOrder[0]).toBeLessThan(inf2.mock.invocationCallOrder[0]);
  });
});
