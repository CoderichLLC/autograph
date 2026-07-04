const { query1, query2 } = require('./service');
const { isGlob, hashObject, buildSelectionTree } = require('../../src/service/AppService');

// Minimal plain-AST field node (the walk touches nothing realm-bound).
const fieldNode = (name, selections) => ({
  kind: 'Field',
  name: { value: name },
  ...(selections ? { selectionSet: { selections } } : {}),
});

describe('AppService', () => {
  test('isGlob', () => {
    expect(isGlob('4?')).toBe(true);
    expect(isGlob('1.??')).toBe(true);
    expect(isGlob('!value')).toBe(true);
    expect(isGlob('TRu?')).toBe(true);
  });

  test('hashObject', () => {
    expect(hashObject(query1)).toEqual(hashObject(query2));
    expect(hashObject(1)).toEqual('1aee48a1ce9885851ed10b486ed333ee181944db');
  });

  describe('buildSelectionTree memo', () => {
    test('keyed on the fieldNodes ARRAY — distinct infos sharing it get the same tree', () => {
      // graphql-js builds a fresh `info` per resolver invocation but memoizes collectSubfields,
      // so N sibling parents resolving the same field share ONE fieldNodes array by identity.
      const fieldNodes = [fieldNode('books', [fieldNode('title')])];
      const tree1 = buildSelectionTree({ fieldNodes, fragments: {} }, 'Book');
      const tree2 = buildSelectionTree({ fieldNodes, fragments: {} }, 'Book');
      expect(tree2).toBe(tree1); // one walk, shared read-only tree
      expect(tree1.fields.has('title')).toBe(true);
    });

    test('distinct fieldNodes arrays never share — even with identical content', () => {
      const make = () => [fieldNode('books', [fieldNode('title')])];
      const tree1 = buildSelectionTree({ fieldNodes: make(), fragments: {} }, 'Book');
      const tree2 = buildSelectionTree({ fieldNodes: make(), fragments: {} }, 'Book');
      expect(tree2).not.toBe(tree1);
      expect([...tree2.fields]).toEqual([...tree1.fields]);
    });

    test('missing/empty info returns null without touching the memo', () => {
      expect(buildSelectionTree(undefined, 'Book')).toBeNull();
      expect(buildSelectionTree({}, 'Book')).toBeNull();
      expect(buildSelectionTree({ fieldNodes: [] }, 'Book')).toBeNull();
    });
  });
});
