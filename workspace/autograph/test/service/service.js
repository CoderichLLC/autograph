const { ObjectId } = require('@coderich/autograph-mongodb');

exports.query1 = {
  model: 'Person',
  flags: { debug: true },
  id: new ObjectId('e4f66987111acdb28f871393'),
  options: {
    collation: { locale: 'en', strength: 2 },
    readPreference: 'primary',
  },
  where: { network: 'networkId' },
  op: 'findOne',
  crud: 'read',
  input: undefined,
  sort: [{ a: 'a' }, { b: 'b' }, { c: 'c' }],
  joins: [
    {
      to: 'Person',
      on: '_id',
      from: 'section.person',
      as: 'join_Person',
      where: { name: 'richard' },
      isArray: undefined,
    },
  ],
};

exports.query2 = {
  id: new ObjectId('e4f66987111acdb28f871393'),
  model: 'Person',
  flags: { debug: true },
  joins: [
    {
      to: 'Person',
      on: '_id',
      from: 'section.person',
      as: 'join_Person',
      where: { name: 'richard' },
      isArray: undefined,
    },
  ],
  options: {
    collation: { locale: 'en', strength: 2 },
    readPreference: 'primary',
  },
  where: { network: 'networkId' },
  op: 'findOne',
  crud: 'read',
  input: undefined,
  sort: [{ b: 'b' }, { c: 'c' }, { a: 'a' }],
};
