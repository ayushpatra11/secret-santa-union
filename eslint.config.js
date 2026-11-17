import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/', '.wrangler/', 'coverage/'] },
  js.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2024, sourceType: 'module' },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      eqeqeq: ['error', 'always'],
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },
  { files: ['public/**/*.js'], languageOptions: { globals: globals.browser } },
  { files: ['src/**/*.js', 'functions/**/*.js'], languageOptions: { globals: globals.serviceworker } },
  { files: ['test/**/*.js', 'e2e/**/*.js', '*.config.js'], languageOptions: { globals: globals.node } },
];
