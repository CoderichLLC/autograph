const { setup } = require('./jest.service');

beforeAll(async () => {
  await setup();
});

afterAll(() => {
  return global.postgresClient.disconnect();
});
