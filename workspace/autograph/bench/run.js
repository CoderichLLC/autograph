/* eslint-disable no-console */
// Framework-overhead benchmark. NOT CI-gated — run `npm run bench`, paste output into
// bench/RESULTS.md. Scenarios isolate the two structural taxes: InstantDriver → CPU
// (interpretation), withLatency → round trips (provisioning).
const { Schema, Resolver } = require('../index');
const InstantDriver = require('./InstantDriver');

const WIDE_FIELDS = Array.from({ length: 24 }, (_, i) => `  f${i}: String`).join('\n');
const typeDefs = `
  type Narrow @model {
    name: String
    age: Int
    email: String
    active: Boolean
    score: Float
  }
  type Wide @model {
    name: String @field(normalize: toLowerCase)
    tag: String @field(serialize: toUpperCase)
    labels: [String]
    meta: WideMeta
${WIDE_FIELDS}
  }
  type WideMeta {
    a: String
    b: String @field(serialize: toLowerCase)
  }
`;

let seq = 0;
const nextId = () => `id${(++seq).toString().padStart(12, '0')}`;

const build = (client) => {
  const config = {
    namespace: 'autograph',
    generators: { default: ({ value }) => value || nextId() },
    dataLoaders: { default: { cache: true } },
    dataSources: { default: { supports: [], client } },
    decorators: { default: 'type decorator { id: ID! @field(key: "_id") }' },
  };
  const schema = new Schema(config).framework().merge(typeDefs).decorate().api();
  return { schema, context: {} };
};

const time = async (label, iterations, fn) => {
  await fn(); // warmup
  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) await fn(); // eslint-disable-line no-await-in-loop
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  console.log(`${label.padEnd(58)} ${(iterations / (ms / 1000)).toFixed(0).padStart(10)} ops/sec`);
};

(async () => {
  const client = new InstantDriver();
  const { schema } = build(client);

  // Seed 500 rows per model, straight into the driver (bypass AG — setup, not measurement).
  for (let i = 0; i < 500; i++) {
    const id = nextId();
    client.table('Narrow').set(id, { _id: id, name: `n${i}`, age: i, email: `e${i}@x.com`, active: true, score: i / 2 });
    const wide = { _id: nextId(), name: `w${i}`, tag: `t${i}`, labels: ['a', 'b'], meta: { a: 'x', b: 'Y' } };
    for (let f = 0; f < 24; f++) wide[`f${f}`] = `v${f}`;
    client.table('Wide').set(wide._id, wide);
  }

  console.log(`node ${process.version} — ${new Date().toISOString()}\n`);

  // CPU scenarios (fresh resolver per call = per-request reality: cold DataLoader).
  await time('read: findMany 500 narrow rows (fresh resolver)', 200, () => new Resolver({ schema, context: {} }).match('Narrow').many());
  await time('read: findMany 500 wide rows (fresh resolver)', 200, () => new Resolver({ schema, context: {} }).match('Wide').many());
  await time('mutation lifecycle: createOne narrow', 500, () => new Resolver({ schema, context: {} }).match('Narrow').save({ name: 'x', age: 1, email: 'x@x.com' }));
  await time('mutation lifecycle: updateOne narrow (incl. pre-image)', 500, async () => {
    const r = new Resolver({ schema, context: {} });
    const doc = await r.match('Narrow').save({ name: 'u', age: 1 });
    await r.match('Narrow').id(doc.id).save({ age: 2 });
  });

  // Round-trip scenario: same update against a 1ms-latency driver.
  const slow = InstantDriver.withLatency(client, 1);
  const { schema: slowSchema } = build(slow);
  await time('latency(1ms): updateOne narrow end-to-end', 100, async () => {
    const r = new Resolver({ schema: slowSchema, context: {} });
    const doc = await r.match('Narrow').save({ name: 'l', age: 1 });
    await r.match('Narrow').id(doc.id).save({ age: 2 });
  });
})();
