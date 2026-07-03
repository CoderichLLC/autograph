const { getEslintConfig } = require('@coderich/dev');

module.exports = getEslintConfig({
  rules: {
    'object-curly-newline': ['error', { minProperties: 20, consistent: true }],
  },
  settings: {
    'import/core-modules': [
      '@coderich/dev',
      '@coderich/autograph-db-tests',
      '@coderich/autograph-mongodb',
      'mongodb-memory-server',
      'pg-mem',
    ],
  },
});
