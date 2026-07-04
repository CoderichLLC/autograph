describe('Where vocabulary — tier-1 operators through the NORMAL (transformed) path', () => {
  let resolver;
  const emails = ['vocab-a@example.com', 'vocab-b@example.com', 'vocab-c@example.com', 'vocab-d@example.com'];
  let people;

  beforeAll(async () => {
    ({ resolver } = global);
    people = await Promise.all([
      resolver.match('Person').save({ name: 'vocab-alpha', emailAddress: emails[0], age: 10 }),
      resolver.match('Person').save({ name: 'vocab-bravo', emailAddress: emails[1], age: 20 }),
      resolver.match('Person').save({ name: 'vocab-charlie', emailAddress: emails[2], age: 30 }),
      resolver.match('Person').save({ name: 'vocab-delta', emailAddress: emails[3] }), // no age
    ]);
  });

  afterAll(async () => {
    const leftovers = await resolver.match('Person').where({ emailAddress: emails }).many();
    await Promise.all(leftovers.map(p => resolver.match('Person').id(p.id).delete()));
  });

  // All queries scoped by the unique email prefix so suite-global data can't pollute assertions.
  const scoped = where => resolver.match('Person').where({ emailAddress: 'vocab-*@example.com', ...where }).many();
  const names = rows => rows.map(r => r.name).sort();

  test('comparisons: $gt / $gte / $lt / $lte', async () => {
    expect(names(await scoped({ age: { $gt: 10 } }))).toEqual(['vocab-bravo', 'vocab-charlie']);
    expect(names(await scoped({ age: { $gte: 20 } }))).toEqual(['vocab-bravo', 'vocab-charlie']);
    expect(names(await scoped({ age: { $lt: 20 } }))).toEqual(['vocab-alpha']);
    expect(names(await scoped({ age: { $lte: 20 } }))).toEqual(['vocab-alpha', 'vocab-bravo']);
    expect(names(await scoped({ age: { $gt: 10, $lt: 30 } }))).toEqual(['vocab-bravo']); // range compose
  });

  test('explicit $in — the historical finalize double-wrap bug stays fixed', async () => {
    // Regression: `{ field: { $in: [...] } }` used to flatten to the key 'field.$in' and get
    // re-wrapped into { 'field.$in': { $in: [...] } } — silently matching nothing.
    expect(names(await scoped({ age: { $in: [10, 30] } }))).toEqual(['vocab-alpha', 'vocab-charlie']);
  });

  test('$nin excludes listed values and MATCHES missing/null values', async () => {
    expect(names(await scoped({ age: { $nin: [10, 20] } }))).toEqual(['vocab-charlie', 'vocab-delta']);
  });

  test('$ne matches missing/null values too', async () => {
    expect(names(await scoped({ age: { $ne: 10 } }))).toEqual(['vocab-bravo', 'vocab-charlie', 'vocab-delta']);
  });

  test('$eq behaves exactly like bare equality', async () => {
    expect(names(await scoped({ age: { $eq: 20 } }))).toEqual(['vocab-bravo']);
  });

  test('$exists means "a non-null value is present" (portable semantics)', async () => {
    expect(names(await scoped({ age: { $exists: true } }))).toEqual(['vocab-alpha', 'vocab-bravo', 'vocab-charlie']);
    expect(names(await scoped({ age: { $exists: false } }))).toEqual(['vocab-delta']);
  });

  test('field pipelines apply INTO operator operands — normalize/serialize behave exactly as equality', async () => {
    // Person.name normalizes toLowerCase: the UPPERCASED operands only match if the pipeline
    // ran inside the operator, per the vocabulary's coercion classes.
    expect(names(await scoped({ name: { $in: ['VOCAB-ALPHA', 'VOCAB-BRAVO'] } }))).toEqual(['vocab-alpha', 'vocab-bravo']);
    expect(names(await scoped({ name: { $ne: 'VOCAB-ALPHA' } }))).toEqual(['vocab-bravo', 'vocab-charlie', 'vocab-delta']);
  });

  test('operator operands on FK fields serialize per element (string id → ObjectId)', async () => {
    const book = await resolver.match('Book').save({ name: 'Vocab Book', price: 9.99, author: people[0].id });
    try {
      // Plain STRING ids in the operand — only per-element serialization makes these match.
      const rows = await resolver.match('Book').where({ author: { $in: [`${people[0].id}`] } }).many();
      expect(rows.map(r => r.name)).toContain('Vocab Book');
      expect(await resolver.match('Book').where({ author: { $ne: `${people[0].id}` } }).many()).not.toContainEqual(expect.objectContaining({ id: book.id }));
    } finally {
      await resolver.match('Book').id(book.id).delete();
    }
  });

  test('the vocabulary allowlist rejects unknown operators LOUDLY', async () => {
    await expect(scoped({ age: { $where: 'true' } })).rejects.toThrow(/Unknown where operator "\$where".*supported operators/);
    await expect(scoped({ age: { $regexx: 'typo' } })).rejects.toThrow(/Unknown where operator/);
  });

  test('the allowlist rejects operator keys mixed with field keys', async () => {
    await expect(scoped({ age: { $gt: 5, sneaky: 1 } })).rejects.toThrow(/cannot mix with field keys/);
  });

  test('DataLoader never cluster-merges operator-valued keys', async () => {
    // Two same-shaped parallel queries differing ONLY in the $gt operand — a naive fanout merge
    // would fold the operator objects into `$in: [{...},{...}]` and corrupt both results.
    const [gt10, gt20] = await Promise.all([
      scoped({ age: { $gt: 10 } }),
      scoped({ age: { $gt: 20 } }),
    ]);
    expect(names(gt10)).toEqual(['vocab-bravo', 'vocab-charlie']);
    expect(names(gt20)).toEqual(['vocab-charlie']);
  });

  test('operators nest under embedded paths — pipelines and key-walking run at EVERY depth', async () => {
    // Section.name normalizes toLowerCase; the operator sits at the END of an embedded path.
    // Proves the full composition: embedded recursion → field pipeline INTO the operand →
    // key-walk with operator-as-leaf → finalize path-flatten with the operator object intact.
    const [p1, p2] = await Promise.all([
      resolver.match('Person').save({ name: 'vocab-sec-a', emailAddress: 'vocab-sec-a@x.com', sections: [{ name: 'SecAlpha' }] }),
      resolver.match('Person').save({ name: 'vocab-sec-b', emailAddress: 'vocab-sec-b@x.com', sections: [{ name: 'SecBravo' }] }),
    ]);
    try {
      const rows = await resolver.match('Person').where({ emailAddress: 'vocab-sec-*@x.com', sections: { name: { $eq: 'SECALPHA' } } }).many();
      expect(rows.map(r => r.name)).toEqual(['vocab-sec-a']); // UPPERCASE operand only matches via deep normalize
      const nin = await resolver.match('Person').where({ emailAddress: 'vocab-sec-*@x.com', sections: { name: { $nin: ['SECALPHA'] } } }).many();
      expect(nin.map(r => r.name)).toEqual(['vocab-sec-b']);
    } finally {
      await resolver.match('Person').id(p1.id).delete();
      await resolver.match('Person').id(p2.id).delete();
    }
  });

  test('globs convert inside list operands ($in); raw RegExp is native-mode territory', async () => {
    // GLOBS are the transformed-path spelling for pattern matching: field pipelines run FIRST
    // (lowercasing/casting the glob STRING like any equality operand), then finalize converts
    // glob→regex — pipeline-safe by construction, inside operands and out. A raw RegExp through
    // the transformed path gets string-mangled by $cast (pre-existing, all fields) — the raw
    // spelling belongs to flags({ native }) mode, which sheds the schema transforms.
    expect(names(await scoped({ name: { $in: ['vocab-a*', 'vocab-b*'] } }))).toEqual(['vocab-alpha', 'vocab-bravo']);
    const native = await resolver.match('Person').flags({ native: ['where'] })
      .where({ email_address: /^vocab-c/ }).many(); // raw column key — native mode skips key-walking too
    expect(names(native)).toEqual(['vocab-charlie']);
  });

  test('flags.native is TRUE driver dialect — outside the vocabulary allowlist entirely', async () => {
    // Mongo's $expr is NOT in the contract vocabulary (the transformed path rejects it), but
    // native mode is the developer's explicit escape hatch to the driver's real language —
    // unvalidated, untranslated, raw column keys — while STILL riding the full resolve()
    // machinery (transactions, DataLoader, deserialize, events).
    await expect(scoped({ age: { $expr: 1 } })).rejects.toThrow(/Unknown where operator/); // transformed path: rejected
    const rows = await resolver.match('Person').flags({ native: ['where'] })
      .where({ $expr: { $eq: ['$name', 'vocab-alpha'] } }).many(); // native path: real Mongo
    expect(names(rows)).toEqual(['vocab-alpha']);
  });

  test('$or composes branches — field pipelines reach operands inside EVERY branch', async () => {
    // The UPPERCASE name only matches if the branch recursed through the where transformer.
    expect(names(await scoped({ $or: [{ age: { $lt: 15 } }, { name: 'VOCAB-CHARLIE' }] }))).toEqual(['vocab-alpha', 'vocab-charlie']);
  });

  test('compounds coexist with field keys (implicit AND) and nest recursively', async () => {
    expect(names(await scoped({ age: { $exists: true }, $or: [{ age: { $lte: 10 } }, { age: { $gte: 30 } }] }))).toEqual(['vocab-alpha', 'vocab-charlie']);
    expect(names(await scoped({ $and: [{ age: { $gte: 10 } }, { $or: [{ name: 'vocab-alpha' }, { age: 30 }] }] }))).toEqual(['vocab-alpha', 'vocab-charlie']);
  });

  test('$not negates field-level predicates and matches missing values (Mongo semantics)', async () => {
    expect(names(await scoped({ age: { $not: { $gt: 15 } } }))).toEqual(['vocab-alpha', 'vocab-delta']);
    expect(names(await scoped({ age: { $not: { $in: [10, 20] } } }))).toEqual(['vocab-charlie', 'vocab-delta']);
  });

  test('validator: compound operators require a non-empty array of where clauses', async () => {
    await expect(scoped({ $or: [] })).rejects.toThrow(/requires a non-empty array/);
    await expect(scoped({ $or: { age: 10 } })).rejects.toThrow(/requires a non-empty array/);
    await expect(scoped({ $or: [{ age: { $bogus: 1 } }] })).rejects.toThrow(/Unknown where operator/); // branches validate too
  });

  test('join paths inside compound branches reject loudly (never silently dropped)', async () => {
    await expect(resolver.match('Book').where({ $or: [{ 'author.name': 'x' }] }).many())
      .rejects.toThrow(/join path .* inside \$or\/\$and/);
  });

  test('bare equality, arrays, and globs are untouched (the additive guarantee)', async () => {
    expect(names(await scoped({ age: 20 }))).toEqual(['vocab-bravo']);
    expect(names(await scoped({ age: [10, 30] }))).toEqual(['vocab-alpha', 'vocab-charlie']); // bare array → $in
    expect(names(await scoped({ name: 'vocab-a*' }))).toEqual(['vocab-alpha']); // glob
  });

  test('legacy ARRAY-where (the OR form) normalizes to $or at the builder boundary', async () => {
    // Regression: `.where([clauseA, clauseB])` predates the vocabulary; mergeDeep spread the
    // array into index keys ('0', '1') the where transformer silently DROPPED — match-all.
    const rows = await resolver.match('Person')
      .where({ emailAddress: 'vocab-*@example.com' })
      .where([{ name: 'vocab-a*' }, { age: { $gte: 30 } }])
      .many();
    expect(names(rows)).toEqual(['vocab-alpha', 'vocab-charlie']); // glob + operator, per branch
  });
});
