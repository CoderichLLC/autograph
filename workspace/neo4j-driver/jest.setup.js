const { setup } = require('./jest.service');

beforeAll(async () => {
  await setup();
});

afterAll(async () => {
  await global.neo4jClient.disconnect();
  await global.boltDriver.close();
  await global.neo4jContainer.stop();
});
