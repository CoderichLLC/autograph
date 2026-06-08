module.exports = {
  verbose: true,
  testTimeout: 20000,
  testEnvironment: 'node',
  collectCoverage: false,
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  testMatch: ['<rootDir>/test/**/?(*.)+(spec|test).[jt]s?(x)'],
};
