const Util = require('@coderich/util');
const { ObjectId } = require('@coderich/autograph-mongodb');
const Transformer = require('../../src/data/Transformer');

describe('Transformer', () => {
  test('identity', () => {
    const transformer = new Transformer();
    const data = transformer.transform({ age: 20 });
    expect(data.age).toBe(20);
    data.age = 22;
    expect(data.age).toBe(22);
  });

  test('multiplier', () => {
    const obj = { age: 10, name: 'anne' };
    const transformer = new Transformer({ shape: { age: [({ value }) => value * 2, ({ value }) => undefined, ({ value }) => value * 2] } });
    const data = transformer.transform(obj);
    expect(obj).toEqual({ age: 10, name: 'anne' });
    expect(data).toEqual({ age: 40, name: 'anne' });
    data.age = 11;
    expect(data).toEqual({ age: 44, name: 'anne' });
  });

  test('arrays', () => {
    const transformer = new Transformer({ shape: { tags: [({ value }) => Util.map(value, v => v.toLowerCase())] } });
    const data = transformer.transform({ tags: ['a', 'b', 'C'] });
    expect(data).toEqual({ tags: ['a', 'b', 'c'] });
    // data.tags.push('D');
    // expect(data).toEqual({ tags: ['a', 'b', 'c', 'd'] });
  });

  test('nested', () => {
    const transformer1 = new Transformer({
      shape: { name: [({ value }) => value.toLowerCase()] },
      defaults: { name: 'defaultName' },
    });

    const transformer2 = new Transformer({
      shape: { age: [({ value }) => value * 2], sections: [({ value }) => Util.map(value, v => transformer1.transform(v))] },
    });

    const data = transformer2.transform({ name: 'name', sections: [{ age: 10 }, { name: 'NAME', age: 20 }] });
    expect(data).toEqual({ name: 'name', sections: [{ name: 'defaultname', age: 10 }, { name: 'name', age: 20 }] });
  });

  test('rename', () => {
    const transformer = new Transformer({ shape: { a: ['b'] } });
    const data = transformer.transform({ a: 'hello' });
    expect(data).toEqual({ b: 'hello' });
    data.a = 'bye';
    expect(data).toEqual({ b: 'bye' });
  });

  /**
   * These two tests expose the shared #config.args mutation bug in Transformer.
   *
   * transform() calls this.args(args) which does Object.assign(this.#config.args, args).
   * Because Object.assign only ADDS/OVERWRITES keys — it never removes them — any arg key
   * set in a previous call persists into subsequent calls that omit that key.
   *
   * This directly mirrors the risk in Schema.js:382 where the embedded child transformer
   * is called with { model, field, query, resolver, context, path } from the parent rule.
   * If the child transformer is ever called later without those keys (e.g. from a different
   * parent or a standalone context), the stale values silently bleed through.
   */
  describe('shared args mutation', () => {
    test('stale args bleed into subsequent calls that omit that key', () => {
      const received = [];

      const transformer = new Transformer({
        shape: {
          name: [({ value, extra }) => {
            received.push(extra);
            return value;
          }],
        },
      });

      transformer.transform({ name: 'first' }, { extra: 'present' });
      transformer.transform({ name: 'second' }); // extra intentionally omitted

      // Call 1 should have received 'present'
      expect(received[0]).toBe('present');
      // Call 2 should receive undefined — extra was not passed
      // FAILS: receives 'present' because Object.assign leaves it in #config.args
      expect(received[1]).toBeUndefined();
    });

    test('child transformer retains parent args after embedded call (mirrors Schema.js:382)', () => {
      const queriesSeenByChild = [];

      const child = new Transformer({
        shape: {
          name: [({ value, query, path }) => {
            queriesSeenByChild.push({ query, path });
            return value;
          }],
        },
      });

      // Simulate the embedded rule in Schema.js:382:
      // parent calls child.transform with { query, path } from parent context
      const parent = new Transformer({
        shape: {
          items: [({ value, query }) => Util.map(value, (v, i) => child.transform(v, { query, path: ['items', i] }))],
        },
      });

      parent.transform({ items: [{ name: 'item1' }] }, { query: 'parentQuery' });

      // Child was called with query='parentQuery' and path=['items',0] — correct
      expect(queriesSeenByChild[0]).toEqual({ query: 'parentQuery', path: ['items', 0] });

      // Now call the child directly, simulating a top-level call (no query, no path)
      child.transform({ name: 'item2' });

      // Should see { query: undefined, path: undefined } — nothing was passed
      // FAILS: sees { query: 'parentQuery', path: ['items', 0] } — stale from parent call
      expect(queriesSeenByChild[1]).toEqual({ query: undefined, path: undefined });
    });
  });

  test('performance', () => {
    const section = new Transformer({
      shape: { id: [({ value }) => new ObjectId(value)], name: [({ value }) => value.toLowerCase()] },
      defaults: { id: undefined, name: 'defaultName' },
    });

    const base = new Transformer({
      shape: { id: [({ value }) => new ObjectId(value)], age: [({ value }) => value * 2], sections: [({ value }) => Util.map(value, v => section.transform(v)), 'sectors'] },
      defaults: { id: undefined },
    });

    const renamer = new Transformer({
      shape: { sections: ['spectors'] },
    });

    const data = Array.from(new Array(1000)).map((el, i) => ({
      name: `Richard${i}`,
      age: 45,
      sections: Array.from(new Array(1000)).map((ele, j) => ({
        name: `Section${j}`,
        age: 22,
        state: 'GA',
      })),
    }));

    console.time('transform');
    expect(base.transform(data)).toEqual(expect.arrayContaining([
      { id: expect.any(ObjectId), name: 'Richard1', age: 90, sectors: expect.arrayContaining([{ id: expect.any(ObjectId), name: 'section1', age: 22, state: 'GA' }]) },
      { id: expect.any(ObjectId), name: 'Richard2', age: 90, sectors: expect.arrayContaining([{ id: expect.any(ObjectId), name: 'section2', age: 22, state: 'GA' }]) },
    ]));
    console.timeEnd('transform');

    console.time('rename');
    expect(renamer.transform(data)).toEqual(expect.arrayContaining([
      { name: 'Richard1', age: 45, spectors: expect.arrayContaining([{ name: 'Section1', age: 22, state: 'GA' }]) },
      { name: 'Richard2', age: 45, spectors: expect.arrayContaining([{ name: 'Section2', age: 22, state: 'GA' }]) },
    ]));
    console.timeEnd('rename');

    console.time('transformRegular');
    expect(data.map((obj) => {
      const newObj = { ...obj };
      newObj.id = new ObjectId(newObj.id);
      newObj.age *= 2;
      newObj.sectors = Util.map(obj.sections, (el) => {
        el.id = new ObjectId(el.id);
        el.name = el.name.toLowerCase();
        return el;
      });
      delete newObj.sections;
      return newObj;
    })).toEqual(expect.arrayContaining([
      { id: expect.any(ObjectId), name: 'Richard1', age: 90, sectors: expect.arrayContaining([{ id: expect.any(ObjectId), name: 'section1', age: 22, state: 'GA' }]) },
      { id: expect.any(ObjectId), name: 'Richard2', age: 90, sectors: expect.arrayContaining([{ id: expect.any(ObjectId), name: 'section2', age: 22, state: 'GA' }]) },
    ]));
    console.timeEnd('transformRegular');
  });
});
