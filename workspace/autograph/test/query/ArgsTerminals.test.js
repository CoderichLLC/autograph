const Resolver = require('../../src/data/Resolver');

// `args()` APPLIES arguments; it must never DISPATCH.
//
// `first` and `last` are both connection arguments and terminal commands — `first(n)` ends in
// `return this.many()` — and `args()` invoked any key that happened to be a builder method. So the
// generated `find${Model}` resolver (`.match(model).args(args).resolve(info)`) executed every
// `first`/`last` query TWICE: once mid-argument-application, discarded, and again when `resolve()`
// ran the real terminal.
//
// The wasted read is the small half. The real cost is that `preQuery`/`postQuery` fired an extra
// time for a query nobody asked for — hooks are where domain logic lives, and "runs once per query"
// is the contract they are written against.
describe('args() applies arguments without dispatching', () => {
  let resolver, spy;

  beforeAll(() => { ({ resolver } = global); });
  beforeEach(() => { spy = jest.spyOn(Resolver.prototype, 'resolve'); });
  afterEach(() => spy.mockRestore());

  const dispatches = () => spy.mock.calls.length;

  // The builder has no `toObject()` — only a terminated Query does. Run one real terminal and read
  // the Query that was actually dispatched, which is the thing hooks and drivers see.
  const executed = async (builder) => {
    await Promise.resolve(builder.many()).catch(() => {});
    return spy.mock.calls[spy.mock.calls.length - 1][0].toObject();
  };

  test('`first` is applied, not run', () => {
    resolver.match('PlainJane').args({ where: { name: 'x' }, first: 2 });
    expect(dispatches()).toBe(0);
  });

  test('`last` is applied, not run', () => {
    resolver.match('PlainJane').args({ last: 2 });
    expect(dispatches()).toBe(0);
  });

  test('the argument still takes effect — one terminal, one dispatch, correct paging', async () => {
    const rs = await resolver.match('PlainJane').args({ first: 2 }).many();
    expect(dispatches()).toBe(1);
    expect(rs.length).toBeLessThanOrEqual(2);
  });

  // A schema extension is free to name an argument `save`, `count` or `delete`. Running one because
  // the name collides with a builder method is the same bug with a far worse blast radius.
  test('no other terminal is invoked as an argument either — it is preserved for hooks', async () => {
    const builder = resolver.match('PlainJane').args({ save: { name: 'must-not-be-written' }, count: 3 });
    expect(dispatches()).toBe(0); // `save` as an argument must not write anything
    const { args, crud } = await executed(builder);
    expect(crud).toBe('read');
    expect(args).toMatchObject({ save: { name: 'must-not-be-written' }, count: 3 });
  });

  test('non-terminal builder methods are still driven by args()', async () => {
    const { where, sort } = await executed(resolver.match('PlainJane').args({ where: { name: 'alpha' }, sortBy: { name: 'asc' } }));
    expect(where).toMatchObject({ name: 'alpha' });
    expect(sort).toEqual({ name: 'asc' });
    expect(dispatches()).toBe(1); // the terminal above, and nothing from args()
  });

  test('an unknown argument is still preserved so hooks can read it', async () => {
    const { args } = await executed(resolver.match('PlainJane').args({ search: 'tennis' }));
    expect(args.search).toBe('tennis');
  });
});
