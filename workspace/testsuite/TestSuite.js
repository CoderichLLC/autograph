// const { Emitter } = require('@coderich/autograph');

let richard;
let christie;
let jane;
let mobyDick;
let healthBook;
let chapter1;
let chapter2;
let chapter3;
let page1;
let page2;
let page3;
let page4;
let page5;
let bookBuilding;
let libraryBuilding;
let apartmentBuilding;
let bookstore1;
let bookstore2;
let library;
let apartment;
let artsy;
let role;

const sorter = (a, b) => {
  const idA = `${a.id}`;
  const idB = `${b.id}`;
  if (idA < idB) return -1;
  if (idA > idB) return 1;
  return 0;
};

module.exports = () => describe('TestSuite', () => {
  let resolver, context, ObjectId;

  // Extend jest!
  expect.extend({
    thunk: (val, fn) => {
      const pass = Boolean(fn(val));
      return { pass };
    },
    multiplex: (val, ...expectations) => {
      try {
        expectations.flat().forEach((expectation) => {
          expectation(val);
        });
        return { pass: true };
      } catch ({ message }) {
        return { message, pass: false };
      }
    },
  });

  beforeAll(() => {
    ({ resolver, ObjectId } = global);
    context = resolver.getContext();

    // /**
    //  * This is a concrete example of how to accidently use an expired session
    //  * This bug has been fixed in Emitter.js to create a clone for "basic" functions
    //  */
    // Emitter.onModels('preMutation', ['Person'], (event) => {
    //   event.resolver.match('Book').where({ name: 'nothing' }).save();
    // });
  });

  describe('Create', () => {
    test('Person', async () => {
      const input = { age: 40, name: 'Richard', status: 'alive', state: 'NJ', emailAddress: 'rich@coderich.com', network: 'network', strip: 'mall', multiLang: 'lang', 'multiLang.en': 'en', 'multiLang.es': 'es' };
      richard = await resolver.match('Person').save(input);
      expect(Object.keys(input).includes('id')).toBe(false);
      expect(richard.id).toBeDefined();
      expect(richard._id).not.toBeDefined();
      expect(richard.age).toBe(40);
      expect(richard.name).toBe('richard');
      expect(richard.gender).toBe('male');
      expect(richard.telephone).toBe('###-###-####'); // Default value

      christie = await resolver.match('Person').save({
        name: 'Christie',
        emailAddress: 'christie@gmail.com',
        gender: 'female',
        friends: [richard.id],
        telephone: 1112223333,
        network: 'network',
        nonsense: 'nonsense',
        section: { name: 'rich', person: richard.id },
        sections: [
          { name: 'rich', person: richard.id },
          { name: 'rich', person: richard.id },
        ],
      });

      expect(christie.id).toBeDefined();
      expect(christie.friends).toEqual([richard.id]);
      expect(christie.nonsense).not.toBeDefined();
      expect(christie.gender).toBe('female');
      expect(christie.telephone).toBe('1112223333'); // Explicitly set
      expect(christie.section).toMatchObject({ name: 'rich', person: richard.id });
      expect(christie.sections).toEqual([
        expect.objectContaining({ name: 'rich', person: richard.id }),
        expect.objectContaining({ name: 'rich', person: richard.id }),
      ]);

      // Tricky data stuff
      expect(richard.status).toBe('alive');
      expect(richard.state).toBe('NJ');
      // expect(richard.multiLang).toBe('lang');
      // expect(richard['multiLang.en']).toBe('en');
      // expect(richard['multiLang.es']).toBe('es');
      expect(richard.strip).not.toBeDefined(); // DB key should be stripped
      expect(richard.network).toBe('networkId');
      expect(richard.createdAt).toBeTruthy();
      expect(richard.updatedAt).toBeTruthy();
    });

    test('Book', async () => {
      mobyDick = await resolver.match('Book').save({ name: 'moby dick', price: 9.99, bids: [1.99, 1.20, 5.00], bestSeller: true, author: richard.id });
      expect(mobyDick.id).toBeDefined();
      expect(mobyDick.name).toBe('Moby Dick');
      expect(mobyDick.price).toBe(9.99);
      expect(mobyDick.author).toEqual(richard.id);

      healthBook = await resolver.match('Book').save({ name: 'Health and Wellness', bids: [5.00, 9.00, 12.50], price: '29.99', author: christie.id });
      expect(healthBook.id).toBeDefined();
      expect(healthBook.name).toEqual('Health And Wellness');
      expect(healthBook.price).toEqual(29.99);
      expect(healthBook.author).toEqual(christie.id);
    });

    test('Chapter', async () => {
      chapter1 = await resolver.match('Chapter').save({ name: 'chapter1', book: healthBook.id });
      chapter2 = await resolver.match('Chapter').save({ name: 'chapter2', book: healthBook.id });
      chapter3 = await resolver.match('Chapter').save({ name: 'newChapter', book: mobyDick }); // Sending the entire object...
      expect(chapter1.id).toBeDefined();
      expect(chapter1.name).toEqual('Chapter1');
      expect(chapter1.book).toEqual(healthBook.id);
      expect(chapter2.id).toBeDefined();
      expect(chapter2.name).toEqual('Chapter2');
      expect(chapter2.book).toEqual(healthBook.id);
      expect(chapter3.id).toBeDefined();
      expect(chapter3.name).toEqual('Newchapter');
      expect(chapter3.book).toEqual(mobyDick.id);
    });

    test('Page', async () => {
      page1 = await resolver.match('Page').save({ number: 1, chapter: chapter1.id, verbage: 'This is the introduction, of sorts.' });
      page2 = await resolver.match('Page').save({ number: 2, chapter: chapter1.id, verbage: 'Now you know.' });
      page3 = await resolver.match('Page').save({ number: 1, chapter: chapter2.id, verbage: 'Ready for more?' });
      page4 = await resolver.match('Page').save({ number: 2, chapter: chapter2.id, verbage: 'The end.' });
      page5 = await resolver.match('Page').save({ number: 1, chapter: chapter3.id, verbage: 'Moby Dick.' });
      await resolver.match('Page').save({ number: 3, chapter: chapter2.id, verbage: 'The real end.' });
      expect(page1.id).toBeDefined();
      expect(page2.id).toBeDefined();
      expect(page3.id).toBeDefined();
      expect(page4.id).toBeDefined();
      expect(page5.id).toBeDefined();
    });

    test('Building', async () => {
      bookBuilding = { year: 1990, type: 'business', tenants: [christie.id] };
      libraryBuilding = { type: 'business', tenants: [christie.id] };
      apartmentBuilding = { type: 'home', year: 1980, tenants: [richard.id, christie.id], landlord: richard.id };
      expect(1).toBe(1);
    });

    test('BookStore', async () => {
      bookstore1 = await resolver.match('BookStore').save({ name: 'Best Books Ever', books: [mobyDick.id, mobyDick.id, healthBook.id], building: bookBuilding });
      bookstore2 = await resolver.match('BookStore').save({ name: 'New Books', books: [mobyDick.id], building: { ...bookBuilding, description: 'A building' } });
      expect(bookstore1.id).toBeDefined();
      expect(bookstore1.books.length).toEqual(3);
      expect(bookstore1.building.type).toEqual('business');
      expect(bookstore1.building.year).toEqual(1990);
      expect(bookstore1.building.tenants).toEqual([christie.id]);
      expect(bookstore1.building.description).toEqual('A building from the bloom');
      expect(bookstore2.id).toBeDefined();
      expect(bookstore2.books.length).toEqual(1);
      expect(bookstore2.building.type).toEqual('business');
      expect(bookstore2.building.description).toEqual('A building');
      expect(bookBuilding.description).not.toBeDefined();
    });

    test('Library', async () => {
      library = await resolver.match('Library').save({ name: 'Public Library', books: [mobyDick.id, healthBook.id, healthBook.id], building: libraryBuilding });
      expect(library.id).toBeDefined();
      expect(library.books.length).toEqual(3);
      expect(library.building.type).toEqual('business');
      expect(library.building.description).toEqual('A building from the bloom');
    });

    test('Apartment', async () => {
      apartment = await resolver.match('Apartment').save({ name: 'Piedmont Beauty', building: apartmentBuilding });
      expect(apartment.id).toBeDefined();
      expect(apartment.building.type).toEqual('home');
      expect(apartment.building.tenants).toEqual([richard.id, christie.id]);
      expect(apartment.building.description).toEqual('A building from the bloom');
    });

    test('Art', async () => {
      artsy = await resolver.match('Art').save({ name: 'My Find Art', sections: [{ name: 'Section1', person: richard.id, type: 'home' }] });
      expect(artsy.id).toBeDefined();
      expect(artsy.sections).toMatchObject([{
        id: expect.thunk(ObjectId.isValid),
        name: 'section1',
        type: 'home',
        frozen: 'frozen',
        createdAt: expect.any(Date),
        updatedAt: expect.any(Date),
      }]);
    });

    test('Role', async () => {
      role = await resolver.match('Role').save({ name: 'admin' });
      expect(role).toMatchObject({
        id: expect.anything(),
        name: 'admin',
      });
    });

    test('PlainJane (with embedded)', async () => {
      jane = await resolver.match('PlainJane').save({
        role: { 'detail.scope': 'r' }, // This tests a bug with unflatten (now fixed in Util)
        roles: [role], // This tests if we can have a FK by something other than ID
        'data.id': 1, // This will test if we can query by nested mixed
      });

      expect(jane).toMatchObject({
        id: expect.anything(),
        role: { detail: { scope: 'r' } },
        roles: ['admin'],
      });
    });
  });

  describe('Get', () => {
    test('Person', async () => {
      expect(await resolver.match('Person').one()).toBeDefined();
      expect(await resolver.match('Person').id(undefined).one()).toBeNull();
      expect(await resolver.match('Person').id(richard.id).one()).toMatchObject({ id: richard.id, name: richard.name, network: 'networkId' });
      expect(await resolver.match('Person').id(christie.id).one()).toMatchObject({ id: christie.id, name: christie.name, friends: [richard.id], network: 'networkId' });
      expect(await resolver.match('Person').id(christie.id).many()).toMatchObject([{ id: christie.id, name: christie.name, friends: [richard.id], network: 'networkId' }]);
      expect(await resolver.match('Person').where({ age: 40 }).one()).toMatchObject({ id: richard.id, name: richard.name, network: 'networkId' });
      expect(await resolver.match('Person').where({ age: '40' }).one()).toMatchObject({ id: richard.id, name: richard.name, network: 'networkId' });
      expect(await resolver.match('Person').where({ age: '4?' }).one()).toMatchObject({ id: richard.id, name: richard.name, network: 'networkId' });
      expect(await resolver.match('Person').where({ age: '??' }).one()).toMatchObject({ id: richard.id, name: richard.name, network: 'networkId' });
      expect(await resolver.match('PlainJane').where({ 'data.id': 1 }).one()).toMatchObject({ id: jane.id });

      // Context switch
      context.network.id = 'networkIdd';
      await expect(resolver.match('Person').where({ name: richard.name }).one({ required: true })).rejects.toThrow(/not found/gi);
      await expect(resolver.match('Person').one({ required: true })).rejects.toThrow(/not found/gi);
      context.network.id = 'networkId';
    });

    test('Book', async () => {
      expect(await resolver.match('Book').id(mobyDick.id).one()).toMatchObject({ id: mobyDick.id, name: 'Moby Dick', author: richard.id });
      expect(await resolver.match('Book').id(healthBook.id).one()).toMatchObject({ id: healthBook.id, name: 'Health And Wellness', author: christie.id });
      expect(await resolver.match('Book').where({ 'author.id': christie.id }).one()).toMatchObject({ id: healthBook.id, name: 'Health And Wellness', author: christie.id });
      expect(await resolver.match('Book').where({ 'author.id': `${christie.id}` }).one()).toMatchObject({ id: healthBook.id, name: 'Health And Wellness', author: christie.id });
      expect(await resolver.match('Book').where({ 'author.id': new ObjectId(christie.id) }).one()).toMatchObject({ id: healthBook.id, name: 'Health And Wellness', author: christie.id });
    });

    test('Chapter', async () => {
      expect(await resolver.match('Chapter').id(chapter1.id).one()).toMatchObject({ id: chapter1.id, name: 'Chapter1', book: healthBook.id });
      expect(await resolver.match('Chapter').id(chapter2.id).one()).toMatchObject({ id: chapter2.id, name: 'Chapter2', book: healthBook.id });
    });

    test('Page', async () => {
      expect(await resolver.match('Page').id(page1.id).one()).toMatchObject({ id: page1.id, number: 1, chapter: chapter1.id });
      expect(await resolver.match('Page').id(page2.id).one()).toMatchObject({ id: page2.id, number: 2, chapter: chapter1.id });
      expect(await resolver.match('Page').id(page3.id).one()).toMatchObject({ id: page3.id, number: 1, chapter: chapter2.id });
      expect(await resolver.match('Page').id(page4.id).one()).toMatchObject({ id: page4.id, number: 2, chapter: chapter2.id });
    });

    test('BookStore', async () => {
      expect(await resolver.match('BookStore').id(bookstore1.id).one()).toMatchObject({ id: bookstore1.id, name: 'Best Books Ever', books: [mobyDick.id, mobyDick.id, healthBook.id], building: expect.objectContaining({ description: 'A building from the bloom' }) });
      expect(await resolver.match('BookStore').id(bookstore2.id).one()).toMatchObject({ id: bookstore2.id, name: 'New Books', books: [mobyDick.id], building: expect.objectContaining({ description: 'A building' }) });
    });

    test('Library', async () => {
      expect(await resolver.match('Library').id(library.id).one()).toMatchObject({ id: library.id, name: 'Public Library', books: [mobyDick.id, healthBook.id, healthBook.id], building: expect.objectContaining({ description: 'A building from the bloom' }) });
    });

    test('Null', async () => {
      expect(await resolver.match('Library').id('no-such-id').one()).toBeNull();
    });
  });

  describe('Find', () => {
    test('Person', async () => {
      expect((await resolver.match('Person').many()).length).toBe(2);
      expect(await resolver.match('Person').where({ name: 'nooneatall' }).many()).toMatchObject([]);
      expect(await resolver.match('Person').where({ name: 'richard' }).many()).toMatchObject([{ id: richard.id, name: 'richard' }]);
      expect(await resolver.match('Person').where({ name: 'Christie' }).many()).toMatchObject([{ id: christie.id, name: 'christie' }]);
      expect(await resolver.match('Person').where({ emailAddress: 'rich@coderich.com' }).many()).toMatchObject([{ id: richard.id, name: 'richard' }]);
      expect(await resolver.match('Person').where({ emailAddress: 'Rich@CodeRich.com' }).many()).toMatchObject([{ id: richard.id, name: 'richard' }]);
      expect((await resolver.match('Person').where({ name: ['Richard', 'Christie'] }).many()).sort(sorter)).toMatchObject([{ id: christie.id, name: 'christie' }, { id: richard.id, name: 'richard' }].sort(sorter));
      expect((await resolver.match('Person').where({ name: '*' }).many()).sort(sorter)).toMatchObject([{ id: christie.id, name: 'christie' }, { id: richard.id, name: 'richard' }].sort(sorter));
      expect((await resolver.match('Person').where({ name: '!richard' }).many()).sort(sorter)).toMatchObject([{ id: christie.id, name: 'christie' }].sort(sorter));
      expect((await resolver.match('Person').where({ name: '!RIC*' }).many()).sort(sorter)).toMatchObject([{ id: christie.id, name: 'christie' }].sort(sorter));
      expect(await resolver.match('Person').where({ authored: mobyDick.id }).many()).toMatchObject([{ id: richard.id, name: 'richard' }]);
      expect(await resolver.match('Person').where({ id: richard.id }).many()).toMatchObject([{ id: richard.id, name: 'richard' }]);
      expect(await resolver.match('Person').where({ id: richard.id }).one()).toMatchObject({ id: richard.id, name: 'richard' });
      expect(await resolver.match('Person').where({ id: `${richard.id}` }).many()).toMatchObject([{ id: richard.id, name: 'richard' }]);
      expect(await resolver.match('Person').where({ id: `${richard.id}` }).one()).toMatchObject({ id: richard.id, name: 'richard' });
      expect(await resolver.match('Person').where({ name: 'absolutelyNoone' }).many()).toEqual([]);
      expect(await resolver.match('Person').where({ name: undefined }).many()).toEqual([]);
      expect(await resolver.match('Person').where({ id: undefined }).many()).toEqual([]);
      expect(await resolver.match('Person').where({ id: undefined, name: 'absolutelyNoone' }).many()).toEqual([]);
      expect(await resolver.match('Person').where({ id: [richard.id, christie.id] }).many()).toMatchObject([{ id: richard.id }, { id: christie.id }]);
      expect(await resolver.match('Person').where({ id: [] }).many()).toEqual([]);

      // Auto resolve (Connection)
      const resolution = await resolver.match('Person').where({ name: ['Richard', 'Christie'] }).resolve({ returnType: 'MyConnection' });
      expect(resolution).toMatchObject({ count: expect.any(Function), edges: expect.any(Function), pageInfo: expect.any(Function) });
      expect(await resolution.count()).toBe(2);
      expect((await resolution.edges()).sort(sorter)).toMatchObject([{ id: christie.id, name: 'christie' }, { id: richard.id, name: 'richard' }].sort(sorter));
    });

    test('Book', async () => {
      expect((await resolver.match('Book').many()).length).toBe(2);
      expect(await resolver.match('Book').where({ author: 'no-such-id' }).many()).toMatchObject([]);
      expect(await resolver.match('Book').where({ author: richard.id }).many()).toMatchObject([{ id: mobyDick.id, name: 'Moby Dick', author: richard.id }]);
      expect(await resolver.match('Book').where({ price: 9.99 }).many()).toMatchObject([{ id: mobyDick.id, name: 'Moby Dick', author: richard.id }]);
      expect(await resolver.match('Book').where({ price: '9.99' }).many()).toMatchObject([{ id: mobyDick.id, name: 'Moby Dick', author: richard.id }]);
      expect(await resolver.match('Book').where({ author: christie.id }).many()).toMatchObject([{ id: healthBook.id, name: 'Health And Wellness', author: christie.id }]);
      expect(await resolver.match('Book').where({ 'author.id': christie.id }).many()).toMatchObject([{ id: healthBook.id, name: 'Health And Wellness', author: christie.id }]);
      expect(await resolver.match('Book').where({ bestSeller: true }).many()).toMatchObject([{ id: mobyDick.id, name: 'Moby Dick', author: richard.id }]);
      expect(await resolver.match('Book').where({ bestSeller: 'TRu?' }).many()).toMatchObject([{ id: mobyDick.id, name: 'Moby Dick', author: richard.id }]);
      expect(await resolver.match('Book').where({ bestSeller: ['TRu?'] }).many()).toMatchObject([{ id: mobyDick.id, name: 'Moby Dick', author: richard.id }]);
      expect(await resolver.match('Book').where({ bestSeller: 'tru' }).many()).toMatchObject([]);
      expect(await resolver.match('Book').where({ price: '?.??' }).many()).toMatchObject([{ id: mobyDick.id, name: 'Moby Dick', author: richard.id }]);
      expect(await resolver.match('Book').where({ price: '??.*' }).many()).toMatchObject([{ id: healthBook.id, name: 'Health And Wellness', author: christie.id }]);
      expect(await resolver.match('Book').where({ bids: [1.99] }).many()).toMatchObject([{ id: mobyDick.id }]);
      expect(await resolver.match('Book').where({ bids: '1.??' }).many()).toMatchObject([{ id: mobyDick.id }]);
      expect(await resolver.match('Book').where({ bids: 1.99 }).many()).toMatchObject([{ id: mobyDick.id }]);
      expect((await resolver.match('Book').where({ bids: 5.00 }).many()).sort(sorter)).toMatchObject([{ id: mobyDick.id }, { id: healthBook.id }].sort(sorter));
      expect(await resolver.match('Book').where({ bids: [19.99, '1.99'] }).many()).toMatchObject([{ id: mobyDick.id }]);
      expect(await resolver.match('Book').where({ chapters: chapter1.id }).many()).toMatchObject([{ id: healthBook.id }]);
      expect(await resolver.match('Book').where({ chapters: [chapter1.id] }).many()).toMatchObject([{ id: healthBook.id }]);
      expect((await resolver.match('Book').where({ chapters: [chapter1.id, chapter3.id] }).many()).sort(sorter)).toMatchObject([{ id: mobyDick.id }, { id: healthBook.id }]);
    });

    test('Chapter', async () => {
      expect((await resolver.match('Chapter').many()).length).toBe(3);
      expect(await resolver.match('Chapter').where({ name: 'cHAPter1' }).many()).toMatchObject([{ id: chapter1.id, name: 'Chapter1', book: healthBook.id }]);
      expect(await resolver.match('Chapter').where({ name: 'cHAPteR2' }).many()).toMatchObject([{ id: chapter2.id, name: 'Chapter2', book: healthBook.id }]);
      expect(await resolver.match('Chapter').where({ name: 'cHAPteR3' }).many()).toEqual([]);
      expect(await resolver.match('Chapter').where({ book: mobyDick.id }).many()).toMatchObject([{ id: chapter3.id, name: 'Newchapter', book: mobyDick.id }]);
      expect(await resolver.match('Chapter').where({ book: 'some-odd-id' }).many()).toEqual([]);
      expect((await resolver.match('Chapter').where({ book: healthBook.id }).many()).sort(sorter)).toMatchObject([
        { id: chapter1.id, name: 'Chapter1', book: healthBook.id },
        { id: chapter2.id, name: 'Chapter2', book: healthBook.id },
      ].sort(sorter));
    });

    test('Page', async () => {
      expect((await resolver.match('Page').many()).length).toBe(6);
      expect((await resolver.match('Page').where({ chapter: chapter1.id }).many()).length).toBe(2);
      expect((await resolver.match('Page').where({ chapter: chapter2.id }).many()).length).toBe(3);
      expect((await resolver.match('Page').where({ number: 1 }).many()).sort(sorter)).toMatchObject([
        { id: page1.id, chapter: chapter1.id },
        { id: page3.id, chapter: chapter2.id },
        { id: page5.id, chapter: chapter3.id },
      ].sort(sorter));
      expect((await resolver.match('Page').where({ number: '2' }).many()).sort(sorter)).toMatchObject([
        { id: page2.id, chapter: chapter1.id },
        { id: page4.id, chapter: chapter2.id },
      ].sort(sorter));
    });

    test('BookStore', async () => {
      expect((await resolver.match('BookStore').many()).length).toBe(2);
      expect((await resolver.match('BookStore').where({ books: [mobyDick.id] }).many()).length).toBe(2);
      expect((await resolver.match('BookStore').where({ name: 'new books' }).many()).sort(sorter)).toMatchObject([
        { id: bookstore2.id, name: 'New Books', building: expect.objectContaining({ ...bookBuilding, description: 'A building' }) },
      ].sort(sorter));
    });

    test('Library', async () => {
      expect((await resolver.match('Library').many()).length).toBe(1);
    });

    test('BookStore', async () => {
      expect((await resolver.match('BookStore').where({ building: bookBuilding }).many()).sort(sorter)).toMatchObject([
        { id: bookstore1.id, name: 'Best Books Ever', building: expect.objectContaining(bookBuilding) },
        { id: bookstore2.id, name: 'New Books', building: expect.objectContaining(bookBuilding) },
      ].sort(sorter));
    });

    test('Apartment', async () => {
      expect((await resolver.match('Apartment').where({ 'building.tenants': 'nobody' }).many()).length).toBe(0);
      expect((await resolver.match('Apartment').where({ 'building.year': 1980 }).many()).length).toBe(1);
      expect((await resolver.match('Apartment').where({ 'building.tenants': richard.id }).many()).length).toBe(1);
    });

    test('Art', async () => {
      expect(await resolver.match('Art').where({ sections: { id: artsy.sections[0].id } }).one()).toMatchObject(artsy);
      expect(await resolver.match('Art').where({ 'sections.id': artsy.sections[0].id }).one()).toMatchObject(artsy);
    });

    test('Segmentation', async () => {
      expect((await resolver.match('Person').many()).length).toBe(2);
    });
  });

  describe('Search (or)', () => {
    test.skip('or', async () => {
      const results = await resolver.match('Person').flags({ debug: true }).where([{ name: 'rich*' }]).many();
      console.log(results);
    });
  });

  describe('Count (find)', () => {
    test('Person', async () => {
      expect(await resolver.match('Person').count()).toBe(2);
      expect(await resolver.match('Person').id(richard.id).count()).toBe(1);
      expect(await resolver.match('Person').where({ id: [] }).count()).toBe(0);
      expect(await resolver.match('Person').where({ id: [richard.id, `${christie.id}`] }).count()).toBe(2);
      expect(await resolver.match('Person').where({ name: 'richard' }).count()).toBe(1);
      expect(await resolver.match('Person').where({ name: 'christie' }).count()).toBe(1);
    });

    test('Book', async () => {
      expect(await resolver.match('Book').count()).toBe(2);
      expect(await resolver.match('Book').where({ author: richard.id }).count()).toBe(1);
      expect(await resolver.match('Book').where({ price: 9.99 }).count()).toBe(1);
      expect(await resolver.match('Book').where({ price: '9.99' }).count()).toBe(1);
      expect(await resolver.match('Book').where({ author: christie.id }).count()).toBe(1);
    });

    test('Chapter', async () => {
      expect(await resolver.match('Chapter').count()).toBe(3);
      expect(await resolver.match('Chapter').where({ name: 'cHAPter1' }).count()).toBe(1);
      expect(await resolver.match('Chapter').where({ name: 'cHAPteR2' }).count()).toBe(1);
      expect(await resolver.match('Chapter').where({ name: 'cHAPteR3' }).count()).toBe(0);
      expect(await resolver.match('Chapter').where({ book: mobyDick.id }).count()).toBe(1);
      expect(await resolver.match('Chapter').where({ book: 'some-odd-id' }).count()).toEqual(0);
      expect(await resolver.match('Chapter').where({ book: healthBook.id }).count()).toBe(2);
    });

    test('Page', async () => {
      expect(await resolver.match('Page').count()).toBe(6);
      expect(await resolver.match('Page').where({ chapter: chapter1.id }).count()).toBe(2);
      expect(await resolver.match('Page').where({ chapter: chapter2.id }).count()).toBe(3);
      expect(await resolver.match('Page').where({ number: 1 }).count()).toBe(3);
      expect(await resolver.match('Page').where({ number: '2' }).count()).toBe(2);
    });

    test('BookStore', async () => {
      expect(await resolver.match('BookStore').count()).toBe(2);
      expect(await resolver.match('BookStore').where({ books: [mobyDick.id] }).count()).toBe(2);
      expect(await resolver.match('BookStore').where({ name: 'new books' }).count()).toBe(1);
    });

    test('Library', async () => {
      expect(await resolver.match('Library').count()).toBe(1);
    });
  });

  describe('Data Validation', () => {
    test('Person', async () => {
      await expect(resolver.match('Person').save()).rejects.toThrow(/required/gi);
      await expect(resolver.match('Person').save({ name: null, emailAddress: null })).rejects.toThrow(/required/gi);
      await expect(resolver.match('Person').save({ name: 'Richard' })).rejects.toThrow(/required/gi);
      await expect(resolver.match('Person').save({ name: 'NewGuy', emailAddress: 'newguy@gmail.com', friends: ['nobody'] })).rejects.toThrow(/not found/gi);
      await expect(resolver.match('Person').save({ name: 'NewGuy', emailAddress: 'newguy@gmail.com', friends: [richard.id, 'nobody'] })).rejects.toThrow(/not found/gi);
      await expect(resolver.match('Person').save({ name: 'NewGuy', emailAddress: 'newguygmail.com' })).rejects.toThrow(/email/gi);
      await expect(resolver.match('Person').id(richard.id).save({ name: 'Christie' })).rejects.toThrow(/duplicate/gi);
      await expect(resolver.match('Person').id(richard.id).save({ name: 'christie' })).rejects.toThrow(/duplicate/gi);
      await expect(resolver.match('Person').id(richard.id).save({ name: null })).rejects.toThrow(/required/gi);
      await expect(resolver.match('Person').id('nobody').save({ name: 'NewGuy' })).rejects.toThrow(/not found/gi);
      await expect(resolver.match('Person').id(richard.id).save({ friends: [richard.id] })).rejects.toThrow(/reference to itself/gi);
      await expect(resolver.match('Person').id(richard.id).save({ gender: 'slug' })).rejects.toThrow(/allows/gi);
    });

    test('Book', async () => {
      await expect(resolver.match('Book').save()).rejects.toThrow();
      await expect(resolver.match('Book').save({ name: 'The Bible', price: 1.99, author: richard.id })).rejects.toThrow(/deny/gi);
      await expect(resolver.match('Book').save({ name: 'No Moby', price: 1.99, author: 'Moses' })).rejects.toThrow(/not found/gi);
      await expect(resolver.match('Book').save({ name: 'No Moby', price: 1.99, author: mobyDick.id })).rejects.toThrow(/not found/gi);
      await expect(resolver.match('Book').save({ name: 'The Bible', price: 1.99, author: [christie.id] })).rejects.toThrow(/deny/gi);
      await expect(resolver.match('Book').save({ name: 'the bible', price: 1.99, author: christie.id })).rejects.toThrow(/deny/gi);
      await expect(resolver.match('Book').save({ name: 'Great Book', price: -1, author: christie.id })).rejects.toThrow(/range/gi);
      await expect(resolver.match('Book').save({ name: 'Best Book', price: 101, author: christie.id })).rejects.toThrow(/range/gi);
      await expect(resolver.match('Book').id(mobyDick.id).save({ author: christie.id })).rejects.toThrow(/immutable/gi);
      await expect(resolver.match('Book').id(mobyDick.id).save({ author: richard.id })).resolves.toBeDefined();
      await expect(resolver.match('Book', { name: 'MoBY DiCK', price: 1.99, author: richard.id }).save()).rejects.toThrow(/required/gi);
    });

    test('Chapter', async () => {
      await expect(resolver.match('Chapter').save()).rejects.toThrow(/required/gi);
      await expect(resolver.match('Chapter').save({ name: 'chapter1' })).rejects.toThrow(/required/gi);
      await expect(resolver.match('Chapter').save({ name: 'chapter2' })).rejects.toThrow(/required/gi);
      await expect(resolver.match('Chapter').save({ name: 'chapter3' })).rejects.toThrow(/required/gi);

      // Composite keys (limited driver support)
      await expect(resolver.match('Chapter').save({ name: 'chapter1', book: healthBook.id })).rejects.toThrow(/duplicate/gi);
      await expect(resolver.match('Chapter').save({ name: 'chapter3', book: christie.id })).rejects.toThrow(/not found/gi);
    });

    test('Page', async () => {
      await expect(resolver.match('Page').save()).rejects.toThrow(/required/gi);
      await expect(resolver.match('Page').save({ number: 3 })).rejects.toThrow(/required/gi);

      // Composite keys (limited driver support)
      await expect(resolver.match('Page').save({ number: 1, chapter: chapter1 })).rejects.toThrow(/duplicate/gi);
      await expect(resolver.match('Page').save({ number: 1, chapter: chapter1.id })).rejects.toThrow(/duplicate/gi);
      await expect(resolver.match('Page').save({ number: 1, chapter: page4.id })).rejects.toThrow(/not found/gi);
      await expect(resolver.match('Page').id(page1.id).save({ number: 2 })).rejects.toThrow(/duplicate/gi);
    });

    test('BookStore', async () => {
      await expect(resolver.match('BookStore').save()).rejects.toThrow(/required/gi);
      await expect(resolver.match('BookStore').save({ name: 'New Books' })).rejects.toThrow(/required/gi);
      await expect(resolver.match('BookStore').save({ name: 'New Books', building: 'bad-building' })).rejects.toThrow(/required/gi);
      await expect(resolver.match('BookStore').save({ name: 'besT bookS eveR', building: bookBuilding })).rejects.toThrow(/duplicate/gi);
      await expect(resolver.match('BookStore').save({ name: 'Best Books Ever', building: libraryBuilding })).rejects.toThrow(/duplicate/gi);
      await expect(resolver.match('BookStore').save({ name: 'More More Books', building: bookBuilding, books: richard.id })).rejects.toThrow(/not found/gi);
      await expect(resolver.match('BookStore').save({ name: 'More More Books', building: bookBuilding, books: [richard.id] })).rejects.toThrow(/not found/gi);
      await expect(resolver.match('BookStore').save({ name: 'More More Books', building: bookBuilding, books: [mobyDick.id, bookBuilding] })).rejects.toThrow(/not found/gi);
    });

    test('Library', async () => {
      await expect(resolver.match('Library').save()).rejects.toThrow(/required/gi);
      await expect(resolver.match('Library').save({ name: 'New Library' })).rejects.toThrow(/required/gi);
      await expect(resolver.match('Library').save({ name: 'New Library', building: 'bad-building' })).rejects.toThrow(/required/gi);
      await expect(resolver.match('Library').save({ name: 'New Library', building: libraryBuilding })).rejects.toThrow(/duplicate/gi);
    });

    test('Art', async () => {
      await expect(resolver.match('Art').save({ name: 'sup', comments: ['whoops'] })).rejects.toThrow(/allow/gi);
      await expect(resolver.match('Art').id(artsy.id).save({ sections: [{ ...artsy.sections[0], frozen: 'rope' }] })).rejects.toThrow(/immutable/gi);
    });
  });

  describe('Data Normalization', () => {
    test('uniq', async () => {
      richard = await resolver.match('Person').id(richard.id).save({ name: 'richard', friends: [christie.id, christie.id, christie.id], telephone: 1234567890 });
      expect(richard.name).toEqual('richard');
      expect(richard.telephone).toEqual('1234567890');
      expect(richard.friends).toEqual([christie.id]);

      // Sanity test to make sure telephone does not get undone
      const sanity = await resolver.match('Person').id(richard.id).save({});
      expect(sanity.telephone).toEqual(richard.telephone);
    });
  });

  describe('Find (Deep)', () => {
    test('Person', async () => {
      expect(await resolver.match('Person').where({ authored: { name: 'Moby Dick' } }).many()).toMatchObject([{ id: richard.id, name: 'richard' }]);
      expect(await resolver.match('Person').where({ authored: { author: { name: 'ChRist??' } } }).many()).toMatchObject([{ id: christie.id, name: 'christie' }]);
      expect(await resolver.match('Person').where({ friends: { name: 'Christie' } }).many()).toMatchObject([{ id: richard.id, name: 'richard' }]);
      expect(await resolver.match('Person').where({ friends: { authored: { name: 'Health*' } } }).many()).toMatchObject([{ id: richard.id, name: 'richard' }]);
      expect(await resolver.match('Person').where({ friends: { authored: { name: 'Cray Cray*' } } }).many()).toMatchObject([]);
      expect(await resolver.match('Person').where({ authored: { chapters: { pages: { verbage: 'city lust' } } } }).many()).toMatchObject([]);
      expect(await resolver.match('Person').where({ authored: { chapters: { pages: { verbage: 'the end.' } } } }).many()).toMatchObject([{ id: christie.id, name: 'christie' }]);
      expect(await resolver.match('Person').where({ authored: { chapters: { pages: { verbage: '*intro*' } } } }).many()).toMatchObject([{ id: christie.id, name: 'christie' }]);
      expect(await resolver.match('Person').where({ authored: { chapters: { name: 'citizen', pages: { verbage: '*intro*' } } } }).many()).toMatchObject([]);
      expect(await resolver.match('Person').where({ authored: { chapters: { name: 'chapter*', pages: { verbage: '*intro*' } } } }).many()).toMatchObject([{ id: christie.id, name: 'christie' }]);
      expect(await resolver.match('Person').where({ authored: { chapters: { name: '{citizen,chap*}' } } }).many()).toMatchObject([{ id: christie.id, name: 'christie' }]);
      expect(await resolver.match('Person').where({ authored: { chapters: { name: ['citizen', 'chap*'], pages: { verbage: '*intro*' } } } }).many()).toMatchObject([{ id: christie.id, name: 'christie' }]);
      expect(await resolver.match('Person').where({ section: { person: { name: 'richard' } } }).one()).toMatchObject({ id: christie.id, name: 'christie' });

      // Covenience counterparts
      expect(await resolver.match('Person').where({ 'authored.name': 'Moby Dick' }).many()).toMatchObject([{ id: richard.id, name: 'richard' }]);
      expect(await resolver.match('Person').where({ 'authored.author.name': 'ChRist??' }).many()).toMatchObject([{ id: christie.id, name: 'christie' }]);
      expect(await resolver.match('Person').where({ 'friends.name': 'Christie' }).many()).toMatchObject([{ id: richard.id, name: 'richard' }]);
      expect(await resolver.match('Person').where({ 'friends.authored.name': 'Health*' }).many()).toMatchObject([{ id: richard.id, name: 'richard' }]);
      expect(await resolver.match('Person').where({ 'friends.authored.name': 'Cray Cray*' }).many()).toMatchObject([]);
      expect(await resolver.match('Person').where({ 'authored.chapters.pages.verbage': 'city lust' }).many()).toMatchObject([]);
      expect(await resolver.match('Person').where({ 'authored.chapters.pages.verbage': 'the end.' }).many()).toMatchObject([{ id: christie.id, name: 'christie' }]);
      expect(await resolver.match('Person').where({ 'authored.chapters.pages.verbage': '*intro*' }).many()).toMatchObject([{ id: christie.id, name: 'christie' }]);
      expect(await resolver.match('Person').where({ 'authored.chapters.name': 'citizen', 'authored.chapters.pages.verbage': '*intro*' }).many()).toMatchObject([]);
      expect(await resolver.match('Person').where({ 'authored.chapters.name': 'chapter*', 'authored.chapters.pages.verbage': '*intro*' }).many()).toMatchObject([{ id: christie.id, name: 'christie' }]);
      expect(await resolver.match('Person').where({ 'authored.chapters.name': '{citizen,chap*}', 'authored.chapters.pages.verbage': '*intro*' }).many()).toMatchObject([{ id: christie.id, name: 'christie' }]);
      expect(await resolver.match('Person').where({ 'authored.chapters': { name: 'citizen', 'pages.verbage': '*intro*' } }).many()).toMatchObject([]);
      expect(await resolver.match('Person').where({ 'authored.chapters': { name: 'chapter*', 'pages.verbage': '*intro*' } }).many()).toMatchObject([{ id: christie.id, name: 'christie' }]);
      expect(await resolver.match('Person').where({ 'authored.chapters': { name: '{citizen,chap*}', 'pages.verbage': '*intro*' } }).many()).toMatchObject([{ id: christie.id, name: 'christie' }]);

      // Auto Resolve (Connection)
      const resolution = await resolver.match('Person').where({ 'authored.chapters': { name: '{citizen,chap*}', 'pages.verbage': '*intro*' } }).resolve({ returnType: 'MyConnection' });
      expect(resolution).toMatchObject({ count: expect.any(Function), edges: expect.any(Function), pageInfo: expect.any(Function) });
      expect(await resolution.count()).toBe(1);
      expect(await resolution.edges()).toMatchObject([{ id: christie.id, name: 'christie' }]);
    });

    test('Book', async () => {
      expect(await resolver.match('Book').where({ author: { name: 'nooneatall' } }).many()).toMatchObject([]);
      expect(await resolver.match('Book').where({ author: { name: 'Richard' } }).many()).toMatchObject([{ id: mobyDick.id }]);
      expect(await resolver.match('Book').where({ author: { authored: { name: 'Moby*' } } }).many()).toMatchObject([{ id: mobyDick.id }]);
      expect(await resolver.match('Book').where({ author: { authored: { name: 'Health*' } } }).many()).toMatchObject([{ id: healthBook.id }]);
      expect((await resolver.match('Book').where({ author: { authored: { name: '*' } } }).many()).sort(sorter)).toMatchObject([{ id: healthBook.id }, { id: mobyDick.id }].sort(sorter));
      expect(await resolver.match('Book').where({ chapters: { name: 'Chapter1' } }).many()).toMatchObject([{ id: healthBook.id }]);
      expect(await resolver.match('Book').where({ chapters: { name: ['chapter1', 'chapter2'] } }).many()).toMatchObject([{ id: healthBook.id }]);
      expect(await resolver.match('Book').where({ chapters: { name: ['chapter1', 'no-chapter'] } }).many()).toMatchObject([{ id: healthBook.id }]);
      expect((await resolver.match('Book').where({ chapters: { name: '*' } }).many()).sort(sorter)).toMatchObject([{ id: mobyDick.id }, { id: healthBook.id }].sort(sorter));
      expect((await resolver.match('Book').where({ chapters: { pages: { number: 1 } } }).many()).sort(sorter)).toMatchObject([{ id: mobyDick.id }, { id: healthBook.id }].sort(sorter));
      expect(await resolver.match('Book').where({ chapters: { pages: { number: 2 } } }).many()).toMatchObject([{ id: healthBook.id }]);
      expect(await resolver.match('Book').where({ chapters: [{ name: 'HongKong' }, chapter1.id] }).many()).toMatchObject([{ id: healthBook.id }]);
    });

    // Sibling FK joins: two independent FK paths on Book filtered simultaneously.
    // mobyDick  → author=richard, chapter=Newchapter
    // healthBook → author=christie, chapters=Chapter1/Chapter2
    // Both constraints are on separate FK fields (author → Person, chapters → Chapter via virtual link).
    // Bug: the second join gets nested inside the first join's $lookup pipeline instead of running
    // as a sibling at the outer level, so it searches for Chapter.book = Person._id (impossible match)
    // and returns [].
    test('Book (sibling joins)', async () => {
      expect(await resolver.match('Book').where({ author: { name: 'richard' }, chapters: { name: 'Newchapter' } }).many()).toMatchObject([{ id: mobyDick.id }]);
    });

    test('Art', async () => {
      expect(await resolver.match('Art').where({ 'sections.name': 'section1' }).one()).toMatchObject({ name: 'My Find Art' });
      expect(await resolver.match('Art').where({ 'sections.name': 'section1' }).many()).toMatchObject([{ name: 'My Find Art' }]);
      expect(await resolver.match('Art').where({ 'sections.person.name': 'rich*' }).many()).toMatchObject([{ name: 'My Find Art' }]);
      expect(await resolver.match('Art').where({ 'sections.person.name': 'who' }).many()).toMatchObject([]);
    });
  });

  describe('Update', () => {
    test('Person', async () => {
      const updated = await resolver.match('Person').id(richard.id).save({ name: 'Rich' });
      expect(updated.createdAt).toEqual(richard.createdAt);
      expect(updated.updatedAt).not.toEqual(richard.updatedAt);
      expect(updated).toMatchObject({ id: richard.id, name: 'rich' });
      expect(await resolver.match('Person').id(richard.id).save({ name: 'richard' })).toMatchObject({ id: richard.id, name: 'richard' });
      expect(await resolver.match('Person').id(richard.id).save({ status: 'active' })).toMatchObject({ id: richard.id, name: 'richard', status: 'active' });
      expect(await resolver.match('Person').id(richard.id).save({ status: null })).toMatchObject({ id: richard.id, name: 'richard', status: null });
      expect(await resolver.match('Person').id(richard.id).save({ id: `${richard.id}` })).toMatchObject({ id: richard.id, name: 'richard', status: null, network: 'networkId' });
      expect(await resolver.match('Person').id(christie.id).save({})).toMatchObject({ id: christie.id, gender: 'female' });
    });

    test('Book', async () => {
      expect(await resolver.match('Book').id(mobyDick.id).save({ name: 'mopey dick' })).toMatchObject({ id: mobyDick.id, name: 'Mopey Dick' });
      expect(await resolver.match('Book').id(mobyDick.id).save({ name: 'moby dick' })).toMatchObject({ id: mobyDick.id, name: 'Moby Dick' });
      expect(await resolver.match('Book').id(mobyDick.id).save({ bids: [] })).toMatchObject({ id: mobyDick.id, name: 'Moby Dick', bids: [] });
      expect(await resolver.match('Book').id(mobyDick.id).save({ bids: null })).toMatchObject({ id: mobyDick.id, name: 'Moby Dick', bids: null });
    });

    test('Apartment', async () => {
      expect(await resolver.match('Apartment').id(apartment.id).save({ 'building.year': 1978 })).toMatchObject({ building: { year: 1978 } });
      expect(await resolver.match('Apartment').id(apartment.id).one()).toMatchObject({ name: apartment.name, building: { year: 1978, tenants: [richard.id, christie.id] } });
    });

    test('Embedded', async () => {
      const { id, sections } = artsy;
      sections.push({ name: 'New Section' });
      expect(await resolver.match('Art').id(id).save({ sections })).toMatchObject({
        sections: [{ ...sections[0], updatedAt: expect.any(Date) }, { id: expect.thunk(ObjectId.isValid), name: 'new section', createdAt: expect.any(Date), updatedAt: expect.any(Date) }],
      });
    });

    test('Push/Pull/Splice', async () => {
      expect(await resolver.match('Book').id(mobyDick.id).push('bids', 2.99, 1.99, 5.55)).toMatchObject({ id: mobyDick.id, name: 'Moby Dick', bids: [2.99, 1.99, 5.55] });
      expect(await resolver.match('Book').id(mobyDick.id).pull('bids', 1.99)).toMatchObject({ id: mobyDick.id, name: 'Moby Dick', bids: [2.99, 5.55] });
      expect(await resolver.match('Book').id(healthBook.id).push('bids', 0.25, 0.25, 11.00, 0.25, 5.00)).toMatchObject({ id: healthBook.id, name: 'Health And Wellness', bids: [5.00, 9.00, 12.50, 0.25, 0.25, 11.00, 0.25, 5.00] });
      expect(await resolver.match('Book').id(healthBook.id).pull('bids', 0.25, 9.00)).toMatchObject({ id: healthBook.id, name: 'Health And Wellness', bids: [5.00, 12.50, 11.00, 5.00] });
      expect(await resolver.match('Book').id(healthBook.id).splice('bids', 5.00, 4.99)).toMatchObject({ id: healthBook.id, name: 'Health And Wellness', bids: [4.99, 12.50, 11.00, 4.99] });
    });
  });

  describe('Remove', () => {
    test('Person', async () => {
      expect(await resolver.match('Person').count()).toBe(2);
      expect(await resolver.match('Person').where({ name: undefined }).delete()).toEqual([]);
    });

    test('Art', async () => {
      const art = await resolver.match('Art').save({ name: 'bye bye', comments: ['yay'] });
      expect(art).toBeDefined();
      expect(await resolver.match('Art').id(art.id).one()).not.toBeNull();
      expect(await resolver.match('Art').id(art.id).remove()).toMatchObject({ id: art.id, name: 'Bye Bye' });
      expect(await resolver.match('Art').id(art.id).one()).toBeNull();
      expect(await resolver.match('Art').id(artsy.id).remove()).toMatchObject({ id: artsy.id, sections: expect.arrayContaining([expect.objectContaining({ frozen: 'frozen' })]) }); // Need to delete it to not mess up later tests
    });
  });

  describe('Query (sortBy sliced results)', () => {
    test('sortBy', async () => {
      expect(await resolver.match('Book').sortBy({ name: 'asc' }).one()).toMatchObject({ id: healthBook.id, name: 'Health And Wellness' });
      expect(await resolver.match('Book').sortBy({ name: 'desc' }).one()).toMatchObject({ id: mobyDick.id, name: 'Moby Dick' });
      expect(await resolver.match('Book').sortBy({ name: 'desc' }).first(1)).toMatchObject([{ id: mobyDick.id, name: 'Moby Dick' }]);
      expect(await resolver.match('Book').sortBy({ name: 'desc' }).last(1)).toMatchObject([{ id: healthBook.id, name: 'Health And Wellness' }]);
      expect(await resolver.match('Book').sortBy({ name: 'asc' }).first(1)).toMatchObject([{ id: healthBook.id, name: 'Health And Wellness' }]);
      expect(await resolver.match('Book').sortBy({ name: 'asc' }).last(1)).toMatchObject([{ id: mobyDick.id, name: 'Moby Dick' }]);
      expect(await resolver.match('Book').sortBy({ name: 'asc' }).first(2)).toMatchObject([{ id: healthBook.id, name: 'Health And Wellness' }, { id: mobyDick.id, name: 'Moby Dick' }]);
      expect(await resolver.match('Book').sortBy({ name: 'asc' }).last(2)).toMatchObject([{ id: healthBook.id, name: 'Health And Wellness' }, { id: mobyDick.id, name: 'Moby Dick' }]);
    });
  });

  describe('Query (sortBy with Cursors)', () => {
    test('sortBy', async () => {
      const [health, moby] = await resolver.match('Book').sortBy({ name: 'asc' }).first(2);
      const [healthCursor, mobyCursor] = [health.$cursor, moby.$cursor];
      expect(healthCursor).toBeDefined();
      expect(mobyCursor).toBeDefined();
      expect(await resolver.match('Book').sortBy({ name: 'asc' }).after(healthCursor).first(1)).toMatchObject([{ id: mobyDick.id, name: 'Moby Dick' }]);
      expect(await resolver.match('Book').sortBy({ name: 'asc' }).after(healthCursor).last(1)).toMatchObject([{ id: mobyDick.id, name: 'Moby Dick' }]);
      expect(await resolver.match('Book').sortBy({ name: 'asc' }).before(healthCursor).first(1)).toMatchObject([]);
      expect(await resolver.match('Book').sortBy({ name: 'asc' }).before(healthCursor).last(1)).toMatchObject([]);
      expect(await resolver.match('Book').sortBy({ name: 'asc' }).after(mobyCursor).first(1)).toMatchObject([]);
      expect(await resolver.match('Book').sortBy({ name: 'asc' }).after(mobyCursor).last(1)).toMatchObject([]);
      expect(await resolver.match('Book').sortBy({ name: 'asc' }).before(mobyCursor).first(1)).toMatchObject([{ id: healthBook.id, name: 'Health And Wellness' }]);
      expect(await resolver.match('Book').sortBy({ name: 'asc' }).before(mobyCursor).last(1)).toMatchObject([{ id: healthBook.id, name: 'Health And Wellness' }]);
    });
  });

  describe('Query (sortBy deep)', () => {
    test('sortBy', async () => {
      expect(await resolver.match('Person').sortBy({ authored: { name: 'asc' } }).many()).toMatchObject([{ id: christie.id }, { id: richard.id }]);
      expect(await resolver.match('Person').sortBy({ authored: { name: 'desc' } }).many()).toMatchObject([{ id: richard.id }, { id: christie.id }]);
      expect(await resolver.match('Person').sortBy({ authored: { chapters: { name: 'asc' } } }).many()).toMatchObject([{ id: christie.id }, { id: richard.id }]);
      expect(await resolver.match('Person').sortBy({ authored: { chapters: { name: 'desc' } } }).many()).toMatchObject([{ id: richard.id }, { id: christie.id }]);

      // Convenience counterparts
      expect(await resolver.match('Person').sortBy({ 'authored.name': 'asc' }).many()).toMatchObject([{ id: christie.id }, { id: richard.id }]);
      expect(await resolver.match('Person').sortBy({ 'authored.name': 'desc' }).many()).toMatchObject([{ id: richard.id }, { id: christie.id }]);
      expect(await resolver.match('Person').sortBy({ 'authored.chapters.name': 'asc' }).many()).toMatchObject([{ id: christie.id }, { id: richard.id }]);
      expect(await resolver.match('Person').sortBy({ 'authored.chapters.name': 'desc' }).many()).toMatchObject([{ id: richard.id }, { id: christie.id }]);
    });
  });

  describe('Query (find & sortBy deep)', () => {
    test('whereSortBy', async () => {
      expect(await resolver.match('Person').where({ 'authored.name': '*' }).sortBy({ authored: { chapters: { name: 'asc', temp: 'asc' } } }).many()).toMatchObject([{ id: christie.id }, { id: richard.id }]);
      expect(await resolver.match('Person').where({ 'authored.name': '*' }).sortBy({ authored: { chapters: { name: 'desc', temp: 'asc' } } }).many()).toMatchObject([{ id: richard.id }, { id: christie.id }]);
      expect(await resolver.match('Person').where({ 'authored.chapters.pages.verbage': 'the end.' }).sortBy({ authored: { chapters: { name: 'asc' } } }).many()).toMatchObject([{ id: christie.id }]);
      expect(await resolver.match('Person').where({ 'authored.chapters.pages.verbage': 'the end.' }).sortBy({ authored: { chapters: { name: 'desc' } } }).many()).toMatchObject([{ id: christie.id }]);
    });
  });

  // describe('Transactions (auto)', () => {
  //   test('multi-update', async () => {
  //     expect(await resolver.match('Person').where({}).save({ status: 'online' })).toMatchObject([{ status: 'online' }, { status: 'online' }]);
  //     expect(await resolver.match('Person').many()).toMatchObject([{ status: 'online' }, { status: 'online' }]);
  //     await resolver.match('Person').where({ status: 'online' }).save({ status: 'offline' });
  //     expect(await resolver.match('Person').many()).toMatchObject([{ status: 'offline' }, { status: 'offline' }]);
  //     await expect(resolver.match('Chapter').save({ name: 'chapter1' }, { name: 'chapter2' })).rejects.toThrow(/required/gi);
  //   });

  //   test('multi-push-pull', async () => {
  //     // push
  //     await resolver.match('Art').save([{ name: 'Art1' }, { name: 'Art2' }]);
  //     await resolver.match('Art').where({}).push('bids', 69.99, '109.99');
  //     expect(await resolver.match('Art').many()).toMatchObject([{ bids: [69.99, 109.99] }, { bids: [69.99, 109.99] }]);

  //     // pull
  //     await resolver.match('Art').where({}).pull('bids', '69.99');
  //     expect(await resolver.match('Art').many()).toMatchObject([{ bids: [109.99] }, { bids: [109.99] }]);
  //   });

  //   test('multi-create rolls back on partial validation failure', async () => {
  //     await expect(resolver.match('Person').save([
  //       { name: 'AtomicCreate1', emailAddress: 'atomic1@example.com' },
  //       { name: 'AtomicCreate2', emailAddress: 'not-an-email' }, // fails @field(validate: email)
  //     ])).rejects.toThrow();
  //     expect(await resolver.match('Person').where({ name: 'AtomicCreate1' }).one()).toBeNull();
  //   });

  //   test('multi-create rolls back on partial uniqueness violation', async () => {
  //     // Seed one record so the second of the pair below collides on the unique name index.
  //     const seed = await resolver.match('Person').save({ name: 'AtomicSeed', emailAddress: 'atomicseed@example.com' });
  //     expect(seed.id).toBeDefined();

  //     await expect(resolver.match('Person').save([
  //       { name: 'AtomicCreate3', emailAddress: 'atomic3@example.com' },
  //       { name: 'AtomicSeed', emailAddress: 'atomic4@example.com' }, // duplicate name → index violation
  //     ])).rejects.toThrow(/duplicate/gi);
  //     expect(await resolver.match('Person').where({ name: 'AtomicCreate3' }).one()).toBeNull();

  //     // Cleanup so subsequent tests aren't affected by AtomicSeed
  //     await resolver.match('Person').id(seed.id).delete();
  //   });

  //   test('multi-update rolls back on partial validation failure', async () => {
  //     // Seed two records, then attempt updateMany where one would fail validation.
  //     const [a, b] = await resolver.match('Person').save([
  //       { name: 'AtomicUpdA', emailAddress: 'updA@example.com' },
  //       { name: 'AtomicUpdB', emailAddress: 'updB@example.com' },
  //     ]);

  //     // Update both: the second will fail validation (invalid email format).
  //     await expect(resolver.match('Person').where({ name: ['AtomicUpdA', 'AtomicUpdB'] }).save({ emailAddress: 'not-an-email' })).rejects.toThrow();

  //     // Verify NEITHER record was updated — both retain their original emailAddress.
  //     const after = await resolver.match('Person').where({ name: ['AtomicUpdA', 'AtomicUpdB'] }).many();
  //     expect(after.map(p => p.emailAddress).sort()).toEqual(['updA@example.com', 'updB@example.com']);

  //     // Cleanup
  //     await resolver.match('Person').id([a.id, b.id]).delete();
  //   });
  // });

  describe('Transactions (manual)', () => {
    test('single txn (commit)', async () => {
      const txn = resolver.transaction();
      const person1$1 = await txn.match('Person').save({ name: 'person1', emailAddress: 'person1@gmail.com' });
      const person2$1 = await txn.match('Person').save({ name: 'person2', emailAddress: 'person2@gmail.com' });
      expect(person1$1).toMatchObject({ id: expect.thunk(ObjectId.isValid), name: 'person1' });
      expect(person2$1).toMatchObject({ id: expect.thunk(ObjectId.isValid), name: 'person2' });
      expect(await resolver.match('Person').id(person1$1.id).one()).toBeNull();
      await txn.commit();
      expect(await resolver.match('Person').id(person1$1.id).one()).not.toBeNull();
    });

    test('single txn (rollback)', async () => {
      const txn = resolver.transaction();
      const person1$1 = await txn.match('Person').save({ name: 'person3', emailAddress: 'person3@gmail.com' });
      const person2$1 = await txn.match('Person').save({ name: 'person4', emailAddress: 'person4@gmail.com' });
      expect(person1$1).toMatchObject({ id: expect.thunk(ObjectId.isValid), name: 'person3' });
      expect(person2$1).toMatchObject({ id: expect.thunk(ObjectId.isValid), name: 'person4' });
      expect(await resolver.match('Person').id(person1$1.id).one()).toBeNull();
      await txn.rollback();
      expect(await resolver.match('Person').id(person1$1.id).one()).toBeNull();
    });

    test('single txn (sequential)', async () => {
      const txn = resolver.transaction();
      await expect(txn.match('Person').id('no-such-id').one({ required: true })).rejects.toThrow(/not found/gi);
      await expect(txn.match('Person').save({ name: 'person2', emailAddress: 'person2@gmail.com' })).rejects.toThrow(/duplicate/gi);
      await txn.rollback();
    });

    test('single txn (parallel)', async () => {
      const txn = resolver.transaction();
      await expect(Promise.all([
        txn.match('Person').save({ name: 'person1', emailAddress: 'person1@gmail.com' }),
        txn.match('Person').save({ name: 'person2', emailAddress: 'person2@gmail.com' }),
      ])).rejects.toThrow(/duplicate/gi);
      await txn.rollback();
    });

    test('single-txn (read & write)', async () => {
      const txn = resolver.transaction();
      const [richie, ...group1] = await Promise.all([
        txn.match('Person').id(richard.id).one(),
        ...Array.from(new Array(1000)).map((el, i) => txn.match('Person').save({ name: `write${i}`, emailAddress: `write${i}@gmail.com` })),
      ]);
      expect(richie.name).toBe('richard');
      expect(group1.length).toBe(1000);
      expect(group1[0].name).toBe('write0');
      await txn.rollback();
    });

    test('multi txn (isolated snapshots)', async () => {
      const txn1 = resolver.transaction();
      const txn2 = resolver.transaction();
      const person1$1 = await txn1.match('Person').save({ name: 'person100', emailAddress: 'person100@gmail.com' });
      expect(await txn1.match('Person').id(person1$1.id).one()).not.toBeNull();
      expect(await txn2.match('Person').id(person1$1.id).one()).toBeNull(); // txns has a "snapshot" of this query (null!)
      expect(await resolver.match('Person').id(person1$1.id).one()).toBeNull();
      await txn1.commit();
      expect(await txn2.match('Person').id(person1$1.id).one()).toBeNull(); // It's null because it's snapshotted!!!!
      expect(await resolver.match('Person').id(person1$1.id).one()).not.toBeNull();
      await txn2.rollback();
    });
  });

  describe('Transactions (manual-with-auto)', () => {
    test('multi-txn (rollback isolates inner writes)', async () => {
      // With the pair/isolated model, an auto-wrap *Many inside a user txn writes into the
      // user txn's pre-session. Reads from the root resolver (outside the txn) see snapshot-
      // isolated state — i.e. nothing until commit.
      const txn1 = resolver.transaction();
      const [person1$1, person2$1] = await txn1.match('Person').save([{ name: 'person10', emailAddress: 'person10@gmail.com' }, { name: 'person11', emailAddress: 'person11@gmail.com' }]);
      expect(person1$1.name).toBe('person10');
      expect(person2$1.name).toBe('person11');

      // Uncommitted: root cannot see in-flight writes.
      expect(await resolver.match('Person').id(person1$1).one()).toBeNull();

      // Rollback: still not visible (never were committed).
      await txn1.rollback();
      expect(await resolver.match('Person').id(person1$1).one()).toBeNull();

      // A second independent txn can create the same names — prior was rolled back, the
      // uniqueness slot is free. Still invisible to root before commit.
      const txn2 = resolver.transaction();
      const [person1$2] = await txn2.match('Person').save([{ name: 'person10', emailAddress: 'person10@gmail.com' }, { name: 'person11', emailAddress: 'person11@gmail.com' }]);
      expect(await resolver.match('Person').id(person1$2).one()).toBeNull();
      await txn2.rollback();
    });

    test('multi-txn (duplicate key with commit)', async () => {
      const txn1 = resolver.transaction();
      await txn1.match('Person').save([{ name: 'person10', emailAddress: 'person10@gmail.com' }, { name: 'person11', emailAddress: 'person11@gmail.com' }]);
      await txn1.commit();

      const txn2 = resolver.transaction();
      await expect(txn2.match('Person').save([{ name: 'person10', emailAddress: 'person10@gmail.com' }, { name: 'person11', emailAddress: 'person11@gmail.com' }])).rejects.toThrow(/duplicate/gi);
      await txn2.rollback();
    });
  });

  describe('Referential Integrity', () => {
    test('remove', async () => {
      expect(() => resolver.match('Person').remove()).toThrow(/delete requires/gi);
      await expect(resolver.match('Person').id(christie.id).remove()).rejects.toThrow(/restricted/gi);
      await resolver.match('Chapter').id(chapter3.id).remove(); // Need to delete chapter to remove Author....
      expect(await resolver.match('Person').id(richard.id).remove()).toMatchObject({ id: richard.id, name: 'richard' });
      expect(await resolver.match('Person').where({ name: '{christie,richard}' }).many()).toMatchObject([{ id: christie.id }]);
      expect(await resolver.match('Book').many()).toMatchObject([{ id: healthBook.id }]);
      expect(await resolver.match('Chapter').sortBy({ name: 'asc' }).many()).toMatchObject([{ id: chapter1.id }, { id: chapter2.id }]);
      expect(await resolver.match('Person').id(christie.id).one()).toMatchObject({
        friends: [],
        section: expect.objectContaining({ person: null }),
        sections: [
          expect.objectContaining({ person: null }),
          expect.objectContaining({ person: null }),
        ], // Embedded array
      });
    });

    test('remove multi', async () => {
      // Create some colors
      const colors = await resolver.match('Color').save([{ type: 'blue' }, { type: 'red' }, { type: 'green' }, { type: 'purple' }]);
      expect(colors.length).toBe(4);

      // Remove some colors
      const ids = await resolver.match('Color').where({ type: '{red,purple}' }).remove();
      const results = await resolver.match('Color').sortBy({ type: 'asc' }).many();
      expect(ids.sort(sorter)).toMatchObject([{ id: colors[1].id }, { id: colors[3].id }].sort(sorter));
      expect(results).toMatchObject([{ type: 'blue' }, { type: 'green' }]);
    });

    test('remove linked fk reference on delete cascade', async () => {
      const dj = await resolver.match('Dependent').save();
      const pj = await resolver.match('PlainJane').save({ dependents: [dj.id] });
      await resolver.match('PlainJane').id(pj.id).delete();
      expect(await resolver.match('Dependent').id(dj.id).one()).toBeNull();
    });

    test('cascade (pull) array of arrays', async () => {
      const roles = await resolver.match('Role').save([{ name: 'RoleA' }, { name: 'RoleB' }]);
      const pj = await resolver.match('PlainJane').save({ roles });
      expect(pj.roles).toEqual(['RoleA', 'RoleB']);
      await resolver.match('Role').id(roles[0].id).delete(); // Delete RoleA
      expect(await resolver.match('PlainJane').id(pj.id).one()).toMatchObject({ roles: ['RoleB'] });
    });

    test('remove fk reference (then update parent)', async () => {
      const r = await resolver.match('Role').save({ name: 'toBeDeleted' });
      const pj = await resolver.match('PlainJane').save({ roles: ['toBeDeleted'] });
      await resolver.match('Role').id(r.id).delete();
      await resolver.match('PlainJane').id(pj.id).save({}); // Bug where deleted role would fail FK constraint when trying to update/save parent record
    });

    test.skip('delete rolls back cascades when a restrict throws mid-walk', async () => {
      // Setup: A is a Person referenced via Person.section.persons (cascade-pull) and
      // A also authored a Book with a Chapter (Book.author cascade → Book.remove() →
      // Chapter.book restrict throws). Person.section.persons cascade fires BEFORE
      // Book.author cascade in the RI walk order, so without atomicity the section.persons
      // pull would commit, then the Book cascade restricts and A's delete fails — leaving
      // partial state.
      const a = await resolver.match('Person').save({ name: 'atomicAuthor', emailAddress: 'atomic-author@example.com' });
      const c = await resolver.match('Person').save({ name: 'atomicSection', emailAddress: 'atomic-section@example.com', section: { name: 'atomicSec', persons: [a.id] } });
      const book = await resolver.match('Book').save({ name: 'Atomic Book', price: 9.99, author: a.id });
      const chapter = await resolver.match('Chapter').save({ name: 'AtomicChapter1', book: book.id });

      // The delete must reject (restrict).
      await expect(resolver.match('Person').id(a.id).delete()).rejects.toThrow(/restrict/gi);

      // Atomicity assertions — nothing should have changed.
      expect(await resolver.match('Person').id(a.id).one()).not.toBeNull();
      expect(await resolver.match('Book').id(book.id).one()).not.toBeNull();
      const cAfter = await resolver.match('Person').id(c.id).one();
      expect(cAfter.section.persons.map(p => `${p}`)).toContain(`${a.id}`);

      // Cleanup so subsequent tests see a clean state.
      await resolver.match('Chapter').id(chapter.id).delete();
      await resolver.match('Book').id(book.id).delete();
      await resolver.match('Person').id(c.id).delete();
      await resolver.match('Person').id(a.id).delete();
    });
  });

  describe('Native Queries', () => {
    test('get', async () => {
      expect(await resolver.match('Person').native({ name: 'Christie' }).one()).toMatchObject({ id: christie.id, name: 'christie', emailAddress: 'christie@gmail.com' }); // case insensitive
      expect(await resolver.match('Person').native({ name: 'christie' }).one()).toMatchObject({ id: christie.id, name: 'christie', emailAddress: 'christie@gmail.com' });
      expect(await resolver.match('Person').native({ name: 'Christie' }).count()).toBe(1); // case insensitive
      expect(await resolver.match('Person').native({ name: 'christie' }).count()).toBe(1);
      const count = await resolver.match('Person').native({ name: { $ne: 'chard' } }).count();
      expect(count).toBeGreaterThanOrEqual(1);
      expect(await resolver.match('Person').native({ name: { $ne: 'christie' } }).count()).toBe(count - 1);
      expect(await resolver.match('Person').native({ email_address: 'christie@gmail.com' }).count()).toBe(1);
    });
  });

  describe('Raw Queries', () => {
    test('get', async () => {
      expect(await resolver.raw('Person').findOne({})).toBeDefined();
      expect(await resolver.raw('Person').findOne({ name: 'richard' })).toBeNull(); // deleted
      expect(await resolver.raw('Person').findOne({ name: 'Christie' })).toBeNull(); // case
      expect(await resolver.raw('Person').findOne({ name: 'christie' })).toMatchObject({ name: 'christie', email_address: 'christie@gmail.com' });
      expect(await resolver.driver('Person').findOne({ name: 'christie' })).toMatchObject({ name: 'christie', email_address: 'christie@gmail.com' }); // Alias

      // Raw -> Match counterparts
      const matchPerson = await resolver.match('Person').where({ name: 'christie' }).one();
      const matchPeople = await resolver.match('Person').many();

      // Raw findOne toResultSet
      const rawPerson = await resolver.raw('Person').findOne({ name: 'christie' });
      const $rawPerson = await resolver.toResultSet('Person', rawPerson);
      expect($rawPerson).toMatchObject(matchPerson);
      expect(`${$rawPerson}`).toBe('Person');

      // Raw array toResultSet
      const rawArray = await resolver.raw('Person').find().then(cursor => cursor.toArray());
      expect(await resolver.toResultSet('Person', rawArray)).toMatchObject(matchPeople);
    });
  });

  describe('Bug Fixes', () => {
    test('embedded arrays', async () => {
      const art = await resolver.match('Art').save({ name: 'Piedmont Beauty', sections: [{ name: 'Section1' }] });
      expect(art.id).toBeDefined();
      expect(art.sections).toMatchObject([{ name: 'section1' }]); // toLowerCase
      expect(art.sections[0].id).toBeDefined();
      expect(art.sections[0].name).toBeDefined();
    });

    test('push/pull embedded arrays', async () => {
      const art = await resolver.match('Art').save({ name: 'Piedmont Beauty' });

      // Push
      const push = await resolver.match('Art').id(art.id).push('sections', { name: 'Pushed Section' });
      expect(push.sections.length).toBe(1);
      expect(push.sections[0].id).toBeDefined();
      expect(push.sections[0].name).toEqual('pushed section'); // toLowerCase

      // Pull
      const pull = await resolver.match('Art').id(art.id).pull('sections', { name: 'pushed section' });
      expect(pull.sections.length).toBe(0);
    });

    test('embedded array with modelRef', async () => {
      // Create section
      await expect(resolver.match('Art').save({ name: 'Piedmont Beauty', sections: [{ name: 'Section1', person: richard.id }] })).rejects.toThrow(/not found/gi);
      const art = await resolver.match('Art').save({ name: 'Piedmont Beauty', sections: [{ name: 'Section1', person: christie.id }] });
      expect(art).toBeDefined();
      expect(art.sections[0].id).toBeDefined();
      expect(art.sections[0].person).toEqual(christie.id);
    });

    test('update should not clobber unknown attributes', async () => {
      await resolver.raw('Person').findOneAndUpdate({ _id: christie.id }, { $set: { section: { name: 'sec', unknown: 'unknown' } } });
      const person = await resolver.match('Person').id(christie.id).save({ section: { name: 'section' } });
      expect(person.section).toEqual(expect.objectContaining({ id: expect.thunk(ObjectId.isValid), name: 'section', frozen: 'frozen' }));
      const dbPerson = await resolver.raw('Person').findOne({ _id: christie.id });
      expect(dbPerson.section).toEqual(expect.objectContaining({ _id: expect.thunk(ObjectId.isValid), name: 'section', unknown: 'unknown' }));
    });

    test('update with brand new embedded attributes are correct', async () => {
      const person = await resolver.match('Person').save({ name: 'new', emailAddress: 'new@new.com' });
      const updated = await resolver.match('Person').id(person.id).save({ section: { name: 'section1' } });
      expect(updated.section).toMatchObject({ id: expect.thunk(ObjectId.isValid), name: 'section1' });
      const sanity = await resolver.match('Person').id(person.id).one();
      expect(sanity.section).toMatchObject({ id: expect.thunk(ObjectId.isValid), name: 'section1' });
    });

    test('where clause with one(required) should throw', async () => {
      await expect(resolver.match('Person').where({ age: 400 }).one({ required: true })).rejects.toThrow(/not found/gi);
      await expect(resolver.match('Person').where({ age: 400 }).many({ required: true })).rejects.toThrow(/not found/gi);
    });

    test('multiple updates in Promise.all()', async () => {
      const people = await resolver.match('Person').many();
      const updated = await Promise.all(people.map((person, i) => resolver.match('Person').id(person.id).save({ age: 20 + i })));
      expect(updated.map(up => up.age)).toEqual(people.map((p, i) => 20 + i));
    });

    test('updating array to object', async () => {
      const pj = await resolver.match('PlainJane').save({ data: [{ lang: 'en', label: 'name' }] });
      const $pj = await resolver.match('PlainJane').id(pj.id).save({ 'data.en': 'name' });
      expect($pj).toMatchObject({
        id: expect.any(ObjectId),
        data: { en: 'name' },
      });
    });
  });

  describe('Case [In]sensitive Sort', () => {
    test('get', async () => {
      // Create documents for sorting purpose (no transformation on name)
      await Promise.all([resolver.match('PlainJane').save({ name: 'boolander' }), resolver.match('PlainJane').save({ name: 'Zoolander' })]);
      expect(await resolver.match('PlainJane').where({ name: '*lander' }).sortBy({ name: 'desc' }).many()).toMatchObject([{ name: 'Zoolander' }, { name: 'boolander' }]);
    });
  });

  describe('$magic methods', () => {
    test('$', async () => {
      const doc = await resolver.match('Person').id(christie.id).one();
      expect(await doc.$.one()).toMatchObject({ id: doc.id });
      expect(await doc.$.many()).toEqual([expect.objectContaining({ id: doc.id })]);
      expect(await doc.$.save({ age: 50 })).toMatchObject({ id: doc.id, age: 50 });
      expect(await Object.assign(doc, { age: 90 }).$.save()).toMatchObject({ id: doc.id, age: 90 });
      expect(await doc.$.lookup('authored').one()).toMatchObject({ id: healthBook.id });
      expect(await doc.$.lookup('authored').where({ name: 'health*' }).one()).toMatchObject({ id: healthBook.id });
      expect(await doc.$.lookup('authored').where({ name: 'moby*' }).one()).toBeNull();
      expect(await doc.$.lookup('friends').count()).toBe(0);
      expect(await doc.$.lookup('authored').count()).toBe(1);
      expect(await healthBook.$.lookup('chapters').count()).toBe(2);
      expect(await jane.$.lookup('roles').count()).toBe(1);
      expect(await jane.$.lookup('roles').many()).toEqual([role]);
      const [chapter, nada] = await healthBook.$.lookup('chapters').where({ name: 'chapter1' }).many();
      expect(chapter.name).toBe('Chapter1');
      expect(nada).toBeUndefined();
    });

    test('$ returns $', async () => {
      const doc = await resolver.match('Person').id(christie.id).one();
      const $doc = await doc.$.one();
      expect(await $doc.$.many()).toEqual([expect.objectContaining({ id: doc.id })]);
      const $save = await $doc.$.save();
      expect(await $save.$.many()).toEqual([expect.objectContaining({ id: doc.id })]);
      const $$save = await $doc.$save();
      expect(await $$save.$.many()).toEqual([expect.objectContaining({ id: doc.id })]);
    });
  });

  // describe('Cascading postMutation hooks (auto-wrap re-entry)', () => {
  //   // Reproduces the Spitfire-style pattern that infinite-cascades through hybridTransaction.match:
  //   //
  //   //   1. Multiple postMutation hooks listen to the same model. Emitter.emit dispatches them via
  //   //      Promise.all → each fn runs in microtask succession on the SAME event.
  //   //   2. Each hook opens a *Many write → transaction(false) pushes a new session.
  //   //   3. The SECOND hook's wrap opens while the first wrap is still on this.#sessions → it
  //   //      nests, creating a hybridTransaction and (in the buggy version) sharing the outer's
  //   //      postCommit array.
  //   //   4. With shared postCommit, the inner commit fires the queued entries, those hooks open
  //   //      yet more nested wraps, which also share the same array, which re-fire the entries…
  //   //      stack overflow inside hybridTransaction.match.
  //   //
  //   // Each session must own its own postCommit list. Placed last so afterAll can remove listeners
  //   // before the next test file picks up the suite.
  //   const seen = { hookA: 0, hookB: 0, colorChain: 0 };
  //   let hookA;
  //   let hookB;
  //   let colorChain;

  //   beforeAll(async () => {
  //     // TWO hooks on Person → Emitter Promise.all dispatches both in microtask succession,
  //     // each opens its own *Many wrap → second nests on first (hybridTransaction created).
  //     hookA = async (event, next) => {
  //       seen.hookA++;
  //       await event.resolver.match('Color').where({}).save({ type: 'red' });
  //       next();
  //     };
  //     hookB = async (event, next) => {
  //       seen.hookB++;
  //       await event.resolver.match('Art').where({}).save({ name: 'cascadeArt' });
  //       next();
  //     };
  //     // Hook on the INNER-op model (Color). Each Color updateOne inside wrap1 will defer its
  //     // postMutation onto the (shared, when buggy) postCommit. When the wrap commits and fires
  //     // the queue, this hook opens ANOTHER *Many wrap on PlainJane — which (because the outer
  //     // wrap is still in the stack chain through hybridTransaction) nests, joins the shared
  //     // postCommit, pushes more entries, and on its commit re-fires the SAME entries →
  //     // exponential cascade through hybridTransaction.match.
  //     colorChain = async (event, next) => {
  //       seen.colorChain++;
  //       // Bounded counter: prevents an actual infinite loop if the wiring lets it slip through.
  //       if (seen.colorChain < 20) {
  //         await event.resolver.match('PlainJane').where({}).save({ name: 'cascadePJ' });
  //       }
  //       next();
  //     };
  //     Emitter.onModels('postMutation', ['Person'], hookA);
  //     Emitter.onModels('postMutation', ['Person'], hookB);
  //     Emitter.onModels('postMutation', ['Color'], colorChain);

  //     // Seed targets so the *Many writes have docs to touch.
  //     await resolver.match('Color').save({ type: 'blue' });
  //     await resolver.match('Art').save({ name: 'cascadeArtSeed' });
  //     await resolver.match('PlainJane').save({ name: 'cascadePJSeed' });
  //   });

  //   afterAll(async () => {
  //     Emitter.removeListener('postMutation', hookA);
  //     Emitter.removeListener('postMutation', hookB);
  //     Emitter.removeListener('postMutation', colorChain);
  //     await resolver.match('Color').where({}).remove();
  //     await resolver.match('Art').where({}).remove();
  //     await resolver.match('PlainJane').where({}).remove();
  //   });

  //   test('parallel hooks + inner-op hook chain do not infinitely cascade', async () => {
  //     seen.hookA = 0;
  //     seen.hookB = 0;
  //     seen.colorChain = 0;

  //     const saved = await resolver.match('Person').save({ name: 'CascadeNested', emailAddress: 'cascadenested@example.com' });
  //     expect(saved.id).toBeDefined();
  //     // Each Person->hook fires exactly once; the chained colorChain should fire once per
  //     // distinct Color-update event, not exponentially.
  //     expect(seen.hookA).toBe(1);
  //     expect(seen.hookB).toBe(1);
  //     expect(seen.colorChain).toBeLessThan(20); // ceiling — bug would race past this

  //     await resolver.match('Person').id(saved.id).delete();
  //   });
  // });
});
