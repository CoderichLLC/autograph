const QueryBuilder = require('../../src/query/QueryBuilder');

describe('QueryBuilder', () => {
  let schema, factory;

  beforeAll(() => {
    ({ schema } = global);
    factory = model => new QueryBuilder({ schema, query: { model } });
  });

  describe('Invalid Combinations', () => {
    test('reuse', () => {
      ['id', 'sort', 'skip', 'limit', 'before', 'after'].forEach((prop) => {
        expect(() => factory('Person')[prop]({})[prop]({})).toThrow(new RegExp(`Cannot redefine "${prop}"`, 'gi'));
      });
    });

    test('paginators', () => {
      ['skip', 'limit', 'before', 'after', 'sort'].forEach((prop) => {
        expect(() => factory('Person').id(1)[prop]({})).toThrow(new RegExp(`Cannot use "${prop}" while using "id"`, 'gi'));
      });
    });

    test('id', () => {
      expect(() => factory('Person').id(1).where({})).not.toThrow(); // This is now OK
      ['sort', 'skip', 'limit', 'before', 'after'].forEach((prop) => {
        expect(() => factory('Person').id(1)[prop]({})).toThrow(new RegExp(`Cannot use "${prop}" while using "id"`, 'gi'));
      });
    });

    test('where', () => {
      expect(() => factory('Person').where({}).where({}).where({})).not.toThrow();
    });
  });

  describe('flags.native', () => {
    // QueryBuilder mutates the passed-in query object in place, so we capture it and inspect after.
    const make = () => {
      const query = { model: 'Person' };
      return { query, builder: new QueryBuilder({ schema, query }) };
    };

    test('native: true sets all three', () => {
      const { query, builder } = make();
      builder.flags({ native: true });
      expect(query.isWhereNative).toBe(true);
      expect(query.isSaveNative).toBe(true);
      expect(query.isSortNative).toBe(true);
    });

    test('native: false (default) leaves all three false', () => {
      const { query, builder } = make();
      builder.flags({ native: false });
      expect(query.isWhereNative).toBe(false);
      expect(query.isSaveNative).toBe(false);
      expect(query.isSortNative).toBe(false);
    });

    test('native: [\'where\'] sets only isWhereNative', () => {
      const { query, builder } = make();
      builder.flags({ native: ['where'] });
      expect(query.isWhereNative).toBe(true);
      expect(query.isSaveNative).toBe(false);
      expect(query.isSortNative).toBe(false);
    });

    test('native: [\'where\', \'save\'] sets the listed members', () => {
      const { query, builder } = make();
      builder.flags({ native: ['where', 'save'] });
      expect(query.isWhereNative).toBe(true);
      expect(query.isSaveNative).toBe(true);
      expect(query.isSortNative).toBe(false);
    });

    test('subsequent flags() recomputes derived flags', () => {
      const { query, builder } = make();
      builder.flags({ native: true }).flags({ native: ['where'] });
      expect(query.isWhereNative).toBe(true);
      expect(query.isSaveNative).toBe(false);
      expect(query.isSortNative).toBe(false);
    });
  });
});
