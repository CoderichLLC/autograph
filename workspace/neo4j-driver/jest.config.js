/* Copyright (c) 2026 Coderich LLC. All Rights Reserved. */

module.exports = {
  verbose: true,
  testTimeout: 60000,
  testEnvironment: 'node',
  collectCoverage: false,
  collectCoverageFrom: ['src/**/**/*.js'],
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  testMatch: ['<rootDir>/test/**/?(*.)+(spec|test).[jt]s?(x)'],
};
