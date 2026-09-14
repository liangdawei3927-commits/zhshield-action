// 智汇码盾基准回归门禁 fixture 的 ESLint flat config（确定性生成，仅内建规则）
module.exports = [
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      'no-unused-vars': 'error',
      'no-console': 'error',
    },
  },
];
