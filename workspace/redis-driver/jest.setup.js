const { setup } = require('./jest.service');

beforeAll(async () => {
  await setup();
});

afterAll(async () => {
  await global.redisClient.disconnect();
  await global.redisMemoryServer.stop();
});
