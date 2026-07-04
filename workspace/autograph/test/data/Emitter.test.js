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
      Emitter.on({ event: 'once', once: true }, fn);
      Emitter.emit('once');
      Emitter.emit('once');
      expect(fn).toBeCalledTimes(1);
    });

    test('onModels', () => {
      const fn = jest.fn();
      Emitter.on({ event: 'onModels', model: 'key' }, fn);
      Emitter.emit('onModels', { query: { model: 'key' } });
      Emitter.emit('onModels', { query: { model: 'miss' } });
      Emitter.emit('onModels', { query: { model: 'key' } });
      expect(fn).toBeCalledTimes(2);
    });

    test('onceModels', () => {
      const fn = jest.fn();
      Emitter.on({ event: 'onceModels', model: 'key', once: true }, fn);
      Emitter.emit('onceModels', { query: { model: 'miss' } }); // Keep this miss first in the test
      Emitter.emit('onceModels', { query: { model: 'key' } });
      Emitter.emit('onceModels', { query: { model: 'key' } });
      expect(fn).toBeCalledTimes(1);
    });

    test('order: participants initiate in ONE flat registration/priority order — arity does not create phases', async () => {
      const fn1 = jest.fn();
      const fn2 = jest.fn((event, next) => next());
      const fn3 = jest.fn();
      Emitter.on('order', fn1);
      Emitter.on('order', fn2);
      Emitter.on('order', fn3);
      await Emitter.emit('order');
      const [[order1], [order2], [order3]] = [fn1.mock.invocationCallOrder, fn2.mock.invocationCallOrder, fn3.mock.invocationCallOrder];
      expect(order1).toBeLessThan(order2);
      expect(order2).toBeLessThan(order3);
    });

    test('order: observers initiate before participants, regardless of registration order', async () => {
      const participant = jest.fn();
      const observer = jest.fn();
      Emitter.on('observerOrder', participant);
      Emitter.observe('observerOrder', observer);
      await Emitter.emit('observerOrder');
      expect(observer.mock.invocationCallOrder[0]).toBeLessThan(participant.mock.invocationCallOrder[0]);
    });
  });

  describe('Observers — fire-and-forget by role, not by arity', () => {
    test('an observer\'s return value never short-circuits, and later participants still run', async () => {
      const observer = jest.fn(() => ({ abort: 'ignored' }));
      const participant = jest.fn();
      Emitter.observe('obsNoAbort', observer);
      Emitter.on('obsNoAbort', participant);
      const value = await Emitter.emit('obsNoAbort');
      expect(observer).toBeCalledTimes(1);
      expect(participant).toBeCalledTimes(1);
      expect(value).toBeUndefined();
    });

    test('an observer\'s SYNC throw is isolated — the event succeeds', async () => {
      const observer = jest.fn(() => { throw new Error('observer boom'); });
      const participant = jest.fn();
      Emitter.observe('obsSyncThrow', observer);
      Emitter.on('obsSyncThrow', participant);
      await expect(Emitter.emit('obsSyncThrow')).resolves.toBeUndefined();
      expect(participant).toBeCalledTimes(1);
    });

    test('an observer\'s ASYNC rejection is deterministically swallowed', async () => {
      const observer = jest.fn(async () => { throw new Error('observer async boom'); });
      Emitter.observe('obsAsyncThrow', observer);
      await expect(Emitter.emit('obsAsyncThrow')).resolves.toBeUndefined();
      expect(observer).toBeCalledTimes(1);
    });

    test('observeOnce fires exactly once', async () => {
      const fn = jest.fn();
      Emitter.observe({ event: 'obsOnce', once: true }, fn);
      await Emitter.emit('obsOnce');
      await Emitter.emit('obsOnce');
      expect(fn).toBeCalledTimes(1);
    });

    test('an observeModels listener filters by model and can be removed by its original reference', async () => {
      const fn = jest.fn();
      Emitter.observe({ event: 'obsModels', model: 'M' }, fn);
      await Emitter.emit('obsModels', { query: { model: 'M' } });
      await Emitter.emit('obsModels', { query: { model: 'miss' } });
      expect(fn).toBeCalledTimes(1);
      Emitter.removeListener('obsModels', fn);
      await Emitter.emit('obsModels', { query: { model: 'M' } });
      expect(fn).toBeCalledTimes(1);
    });

    test('an async PARTICIPANT\'s resolved value now short-circuits (return value === next(value))', async () => {
      const fn1 = jest.fn(async () => ({ abort: 'async-participant' }));
      const fn2 = jest.fn((event, next) => setImmediate(() => next()));
      Emitter.on('asyncParticipantAbort', fn1);
      Emitter.on('asyncParticipantAbort', fn2);
      const value = await Emitter.emit('asyncParticipantAbort');
      expect(value).toEqual({ abort: 'async-participant' });
    });
  });

  describe('Event mutations', () => {
    test('preMutation', (done) => {
      Emitter.on({ event: 'preMutation', model: 'Person', once: true }, (event, next) => {
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

      Emitter.on({ event: 'postMutation', model: 'Person', once: true }, (event) => {
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
      Emitter.on({ event: 'validate', model: 'Person', once: true }, (event, next) => {
        event.query.input.age = 40;
        next();
      });

      Emitter.on({ event: 'postMutation', model: 'Person', once: true }, (event) => {
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
      Emitter.on({ event: 'basicAbort', model: 'M' }, fn1);
      Emitter.on('basicAbort', fn2);
      Emitter.on('basicAbort', fn3);
      const value = await Emitter.emit('basicAbort', { query: { model: 'M' } });
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
      expect(fn2).toBeCalledTimes(0); // registered after fn1 — never initiated (fail fast)
      expect(fn3).toBeCalledTimes(1); // registered BEFORE fn1 — flat order initiated it first
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
    Emitter.on({ event: 'event', priority: 1 }, fn3);
    Emitter.emit('event');
    expect(fn1.mock.invocationCallOrder[0]).toBeLessThan(fn2.mock.invocationCallOrder[0]);
    expect(fn3.mock.invocationCallOrder[0]).toBeLessThan(fn1.mock.invocationCallOrder[0]);

    // Priority
    const fn11 = jest.fn();
    const fn21 = jest.fn();
    const fn31 = jest.fn();
    Emitter.on('event', fn11);
    Emitter.on({ event: 'event', priority: -Infinity }, fn31);
    Emitter.on({ event: 'event', priority: 1 }, fn21);
    Emitter.emit('event');
    expect(fn21.mock.invocationCallOrder[0]).toBeLessThan(fn11.mock.invocationCallOrder[0]);
    expect(fn21.mock.invocationCallOrder[0]).toBeLessThan(fn31.mock.invocationCallOrder[0]);
    expect(fn11.mock.invocationCallOrder[0]).toBeLessThan(fn31.mock.invocationCallOrder[0]);

    // Infinities
    const inf1 = jest.fn();
    const inf2 = jest.fn();
    Emitter.on({ event: 'event', priority: Infinity }, inf1);
    Emitter.on({ event: 'event', priority: Infinity }, inf2);
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
      Emitter.on({ event: 'memoBasic', memoize: true }, fn);
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
      Emitter.on({ event: 'memoNext', memoize: true }, fn);
      const event = { resolver, query: { model: 'M', crud: 'read', op: 'findOne', where: { id: 1 } } };
      await Emitter.emit('memoNext', event);
      await Emitter.emit('memoNext', event);
      expect(fn).toBeCalledTimes(1);
    });

    test('memoize without resolver is a silent no-op', async () => {
      const fn = jest.fn(() => undefined);
      Emitter.on({ event: 'memoNoResolver', memoize: true }, fn);
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

  describe('removeListener on model-filtered registrations (regression)', () => {
    // Bug: #createWrapper (the pre-0.16 backing for onModels/onKeys/onceModels/onceKeys) built
    // its own wrapper closure but never set `.listener` on it — the same convention
    // wrapBasicMemoize/wrapNextMemoize already rely on so `removeListener(event, originalFn)` can
    // find a wrapped listener via `l.listener === listener`. Without it, removeListener could
    // never find or remove a model-filtered hook by its original function reference — the wrapper
    // (and thus the hook) stayed registered forever, regardless of how many times the caller
    // "removed" it. The filter-object #register() carries the same `.listener` back-link forward.
    test('a basic-style (arity < 2) model-filtered listener can be removed by its original function reference', async () => {
      const fn = jest.fn(() => undefined);
      Emitter.on({ event: 'removeMeBasic', model: 'M' }, fn);
      Emitter.removeListener('removeMeBasic', fn);
      await Emitter.emit('removeMeBasic', { resolver, query: { model: 'M', crud: 'read', op: 'findOne' } });
      expect(fn).not.toHaveBeenCalled();
    });

    test('a next-style (arity >= 2) model-filtered listener can be removed by its original function reference', async () => {
      const fn = jest.fn((event, next) => next());
      Emitter.on({ event: 'removeMeNext', model: 'M' }, fn);
      Emitter.removeListener('removeMeNext', fn);
      await Emitter.emit('removeMeNext', { resolver, query: { model: 'M', crud: 'read', op: 'findOne' } });
      expect(fn).not.toHaveBeenCalled();
    });
  });

  describe('filter-object registration (0.16 API)', () => {
    afterEach(() => {
      ['fEvents', 'fEvents2', 'fCrud', 'fAnd', 'fOnce', 'fDispose', 'fShort'].forEach(e => Emitter.removeAllListeners(e));
    });

    test('event plurality: one registration fires on every listed event; disposer removes all', async () => {
      const seen = [];
      const off = Emitter.on({ event: ['fEvents', 'fEvents2'] }, (event) => { seen.push(event.tag); });
      await Emitter.emit('fEvents', { tag: 'a' });
      await Emitter.emit('fEvents2', { tag: 'b' });
      expect(seen).toEqual(['a', 'b']);
      off();
      await Emitter.emit('fEvents', { tag: 'c' });
      expect(seen).toEqual(['a', 'b']); // disposed everywhere
      off(); // idempotent — second call is a no-op
    });

    test('crud filter: both spellings; body never runs for filtered-out ops', async () => {
      const seen = [];
      Emitter.on({ event: 'fCrud', crud: 'cu' }, (e) => { seen.push(`flags:${e.query.crud}`); });
      Emitter.on({ event: 'fCrud', crud: ['create', 'update'] }, (e) => { seen.push(`words:${e.query.crud}`); });
      await Emitter.emit('fCrud', { query: { crud: 'create' } });
      await Emitter.emit('fCrud', { query: { crud: 'read' } }); // filtered out by both
      await Emitter.emit('fCrud', { query: { crud: 'update' } });
      expect(seen.sort()).toEqual(['flags:create', 'flags:update', 'words:create', 'words:update']);
    });

    test('AND across dimensions, OR within: { model: [A,B], crud: c }', async () => {
      const seen = [];
      Emitter.on({ event: 'fAnd', model: ['A', 'B'], crud: 'c' }, (e) => { seen.push(`${e.query.model}:${e.query.crud}`); });
      await Emitter.emit('fAnd', { query: { model: 'A', crud: 'create' } }); // match
      await Emitter.emit('fAnd', { query: { model: 'C', crud: 'create' } }); // model rejects
      await Emitter.emit('fAnd', { query: { model: 'B', crud: 'update' } }); // crud rejects
      await Emitter.emit('fAnd', { query: { model: 'B', crud: 'create' } }); // match
      expect(seen).toEqual(['A:create', 'B:create']);
    });

    test('once across events: first MATCHING emit on ANY event disposes the whole registration', async () => {
      const seen = [];
      Emitter.on({ event: ['fOnce', 'fEvents'], model: 'M', once: true }, (e) => { seen.push(e.query.model); });
      await Emitter.emit('fOnce', { query: { model: 'X' } }); // non-matching: does NOT consume the once
      await Emitter.emit('fEvents', { query: { model: 'M' } }); // consumes — disposes BOTH wrappers
      await Emitter.emit('fOnce', { query: { model: 'M' } });
      expect(seen).toEqual(['M']);
    });

    test('string shorthand ≡ { event }: registration and removeListener both work', async () => {
      const seen = [];
      const fn = (event) => { seen.push(event.tag); };
      Emitter.on('fDispose', fn);
      await Emitter.emit('fDispose', { tag: 'x' });
      Emitter.removeListener('fDispose', fn);
      await Emitter.emit('fDispose', { tag: 'y' });
      expect(seen).toEqual(['x']);
    });

    test('a filtered participant still short-circuits and aborts like a bare one', async () => {
      Emitter.on({ event: 'fShort', model: 'M' }, () => 'veto');
      await expect(Emitter.emit('fShort', { query: { model: 'M' } })).resolves.toBe('veto');
      await expect(Emitter.emit('fShort', { query: { model: 'X' } })).resolves.toBeUndefined();
    });

    describe('registration-time validation (loud)', () => {
      test('unknown filter keys throw, naming the allowlist', () => {
        expect(() => Emitter.on({ event: 'x', models: 'P' }, () => {})).toThrow(/Unknown Emitter filter key.*models.*allowed: event, model, crud, priority, once, memoize/);
      });
      test('unknown crud flags/words throw', () => {
        expect(() => Emitter.on({ event: 'x', crud: 'cz' }, () => {})).toThrow(/Unknown crud filter "z"/);
        expect(() => Emitter.on({ event: 'x', crud: ['upsert'] }, () => {})).toThrow(/Unknown crud filter "upsert"/);
      });
      test('missing/empty event throws; non-function listener throws; non-object filter throws', () => {
        expect(() => Emitter.on({ model: 'P' }, () => {})).toThrow(/at least one event/);
        expect(() => Emitter.on({ event: [] }, () => {})).toThrow(/at least one event/);
        expect(() => Emitter.on('x', 'nope')).toThrow(/listener must be a function/);
        expect(() => Emitter.on(42, () => {})).toThrow(/event name or filter object/);
      });

      test('a third options argument throws — the old on(event, fn, options) signature is gone', () => {
        expect(() => Emitter.on('x', () => {}, { priority: 5 })).toThrow(/fold options into the filter/);
        expect(() => Emitter.observe('x', () => {}, { memoize: true })).toThrow(/fold options into the filter/);
      });

      test('empty model/crud filters throw — a silent never-match listener is forbidden', () => {
        expect(() => Emitter.on({ event: 'x', model: [] }, () => {})).toThrow(/"model" requires at least one value/);
        expect(() => Emitter.on({ event: 'x', crud: [] }, () => {})).toThrow(/"crud" requires at least one value/);
        expect(() => Emitter.on({ event: 'x', crud: '' }, () => {})).toThrow(/"crud" requires at least one value/);
      });
    });

    describe('removed methods are poisoned (base EventEmitter must not silently resurface them)', () => {
      test.each([
        ['once', /once\(\) was removed in 0\.16.*once: true/],
        ['addListener', /addListener\(\) was removed in 0\.16/],
        ['prependListener', /prependListener\(\) was removed in 0\.16.*priority/],
        ['prependOnceListener', /prependOnceListener\(\) was removed in 0\.16/],
        ['onModels', /onModels\(\) was removed in 0\.16.*model/],
        ['onceModels', /onceModels\(\) was removed in 0\.16/],
        ['onKeys', /onKeys\(\) was removed in 0\.16.*model.*crud/],
        ['onceKeys', /onceKeys\(\) was removed in 0\.16/],
        ['observeOnce', /observeOnce\(\) was removed in 0\.16/],
        ['observeModels', /observeModels\(\) was removed in 0\.16/],
        ['observeKeys', /observeKeys\(\) was removed in 0\.16/],
      ])('%s() throws with migration guidance', (name, re) => {
        expect(() => Emitter[name]('x', () => {})).toThrow(re);
      });
    });

    describe('hasListenersFor(event, model) — byKey index removed', () => {
      test('model-filtered → indexed by model; crud-only → generic (conservative); disposal decrements', () => {
        const off1 = Emitter.on({ event: 'fIdx', model: 'P' }, () => {});
        expect(Emitter.hasListenersFor('fIdx', 'P')).toBe(true);
        expect(Emitter.hasListenersFor('fIdx', 'Q')).toBe(false);
        const off2 = Emitter.on({ event: 'fIdx', crud: 'c' }, () => {});
        expect(Emitter.hasListenersFor('fIdx', 'Q')).toBe(true); // crud-only counts generic — conservative
        off2();
        expect(Emitter.hasListenersFor('fIdx', 'Q')).toBe(false);
        off1();
        expect(Emitter.hasListenersFor('fIdx', 'P')).toBe(false);
      });
    });
  });
});
