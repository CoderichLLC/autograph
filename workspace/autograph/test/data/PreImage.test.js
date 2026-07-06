const Schema = require('../../src/schema/Schema');
const Resolver = require('../../src/data/Resolver');
const Emitter = require('../../src/data/Emitter');
const Pipeline = require('../../src/data/Pipeline');

// Contract-compliant stub driver (updateOne → post-image, deleteOne → pre-image) that logs
// every AG-visible op — the unit-level analog of the TestSuite's instrumented budgets.
/* eslint-disable class-methods-use-this */
class StubClient {
  constructor() { this.log = []; this.rows = new Map(); }

  prepare(query) { return query; }

  execute(plan) {
    this.log.push(plan.op);
    const all = [...this.rows.values()];
    const match = w => all.find(r => Object.entries(w ?? {}).every(([k, v]) => `${r[k]}` === `${v}`));
    switch (plan.op) {
      case 'findOne': return Promise.resolve(match(plan.where) ?? null);
      case 'findMany': return Promise.resolve(all.filter(r => Object.entries(plan.where ?? {}).every(([k, v]) => `${r[k]}` === `${v}`)));
      case 'count': return Promise.resolve(all.length);
      case 'createOne': { const row = { ...plan.input }; this.rows.set(`${row._id}`, row); return Promise.resolve(row); }
      case 'updateOne': { const row = match(plan.where); if (!row) return Promise.resolve(null); Object.assign(row, plan.input); return Promise.resolve({ ...row }); }
      case 'deleteOne': { const row = match(plan.where); if (row) this.rows.delete(`${row._id}`); return Promise.resolve(row ?? null); }
      default: return Promise.resolve(null);
    }
  }

  disconnect() {}
}
/* eslint-enable class-methods-use-this */

Pipeline.define('customNoop', ({ value }) => value); // deliberately untagged — must block elision

let seq = 0;
const setup = () => {
  const client = new StubClient();
  const config = {
    namespace: 'autograph',
    generators: { default: ({ value }) => value || `id${++seq}` },
    dataLoaders: { default: { cache: true } },
    dataSources: { default: { supports: [], client } },
    decorators: { default: 'type decorator { id: ID! @field(key: "_id") }' },
  };
  const schema = new Schema(config).framework().merge(`
    type Plain @model { name: String age: Int }
    type Immutable @model { name: String @field(validate: immutable) }
    type Custom @model { name: String @field(normalize: customNoop) }
    type Nested @model { name: String sub: Sub }
    type Sub { label: String }
    type Owner @model { name: String pets: [Pet] @link(by: owner) }
    type Pet @model { name: String owner: Owner @field(onDelete: cascade) }
  `).decorate().api();
  const resolver = new Resolver({ schema, context: {} });
  return { client, schema, resolver };
};

describe('Pre-image elision', () => {
  test('parse computes doc-freedom per model', () => {
    const { schema } = setup();
    const { models } = schema.parse();
    expect(models.Plain.updateDocFree).toBe(true);
    expect(models.Immutable.updateDocFree).toBe(false); // immutable reads query.doc
    expect(models.Custom.updateDocFree).toBe(false); // untagged custom pipeline — conservative
    expect(models.Nested.updateDocFree).toBe(false); // embedded fields excluded in v1
    expect(models.Plain.deleteDocFree).toBe(true);
    expect(models.Owner.deleteDocFree).toBe(false); // RI edges need the pre-image
  });

  test('updateOne on a doc-free model skips the pre-image read', async () => {
    const { client, resolver } = setup();
    const doc = await resolver.match('Plain').save({ name: 'a', age: 1 });
    client.log.length = 0;
    const updated = await resolver.match('Plain').id(doc.id).save({ age: 2 });
    expect(updated.age).toBe(2);
    expect(updated.name).toBe('a'); // response is the driver's post-image
    expect(client.log).toEqual(['updateOne']); // no findOne
  });

  test('elided updateOne of a missing id still throws Not Found', async () => {
    const { resolver } = setup();
    await expect(resolver.match('Plain').id('nope').save({ age: 2 })).rejects.toThrow(/Plain Not Found/);
  });

  test('a doc-reading pipeline restores the pre-image read (and works)', async () => {
    const { client, resolver } = setup();
    const doc = await resolver.match('Immutable').save({ name: 'fixed' });
    client.log.length = 0;
    await expect(resolver.match('Immutable').id(doc.id).save({ name: 'changed' })).rejects.toThrow(/immutable/);
    expect(client.log[0]).toBe('findOne'); // pre-image was fetched for the pipeline
  });

  test('a listener on the model suspends elision; disposing restores it', async () => {
    const { client, resolver } = setup();
    const doc = await resolver.match('Plain').save({ name: 'l', age: 1 });
    const seen = [];
    const off = Emitter.on({ event: 'postMutation', model: 'Plain' }, (event) => { seen.push(event.query.doc); });
    client.log.length = 0;
    await resolver.match('Plain').id(doc.id).save({ age: 2 });
    expect(client.log).toEqual(['findOne', 'updateOne']); // listener is entitled to query.doc
    expect(seen[0]).toBeDefined();
    off();
    client.log.length = 0;
    await resolver.match('Plain').id(doc.id).save({ age: 3 });
    expect(client.log).toEqual(['updateOne']); // elision back after dispose
  });

  test('deleteOne on a doc-free model is 1 call and returns the pre-image', async () => {
    const { client, resolver } = setup();
    const doc = await resolver.match('Plain').save({ name: 'd', age: 9 });
    client.log.length = 0;
    const deleted = await resolver.match('Plain').id(doc.id).delete();
    expect(client.log).toEqual(['deleteOne']);
    expect(deleted.name).toBe('d'); // driver pre-image, deserialized through toResultSet
    await expect(resolver.match('Plain').id(doc.id).delete()).rejects.toThrow(/Plain Not Found/);
  });

  test('deleteOne with RI edges keeps the transactional pre-fetch walk', async () => {
    const { client, resolver } = setup();
    const owner = await resolver.match('Owner').save({ name: 'o' });
    client.log.length = 0;
    await resolver.match('Owner').id(owner.id).delete();
    expect(client.log[0]).toBe('findOne'); // RI walk reads the pre-image first
  });
});
