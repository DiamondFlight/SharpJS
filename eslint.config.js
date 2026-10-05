import js from '@eslint/js';
import globals from 'globals';

// Files carried over from the original single-file SharpJS. They only get correctness checks
// (undefined names, duplicate keys, ...) until they are cleaned up; new code gets the full set.
const LEGACY = [
  'src/viewer/engine.js',
  'src/calc/**/*.js',
  'src/io/sharppy.js',
  'src/io/export.js',
  'src/io/vwp.js',
  'src/io/nexrad-vwp-parser.js',
];

export default [
  { ignores: ['dist/**', 'node_modules/**', 'src/data/**', 'test-results/**'] },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
    },
  },
  {
    files: LEGACY,
    rules: {
      'no-unused-vars': 'off',
      'no-redeclare': 'off',
      'no-empty': 'off',
      'no-useless-escape': 'off',
      'no-extra-semi': 'off',
      'no-case-declarations': 'off',
      'no-prototype-builtins': 'off',
      'no-self-assign': 'off',
      'no-useless-assignment': 'off',
      'no-cond-assign': 'off',
      'no-loss-of-precision': 'off',
      'no-dupe-else-if': 'off',
      'no-unreachable': 'off',
      'no-constant-binary-expression': 'off',
      'no-constant-condition': 'off',
    },
  },
];
