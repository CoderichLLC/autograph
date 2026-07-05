module.exports = {
  verbose: true,
  testTimeout: 60000, // first run downloads the redis-server binary in beforeAll
  testEnvironment: 'node',
  collectCoverage: false,
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  testMatch: ['<rootDir>/test/**/?(*.)+(spec|test).[jt]s?(x)'],
};
