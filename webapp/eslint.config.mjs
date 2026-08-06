import js from '@eslint/js';
import globals from 'globals';

/*
 * Lint config for the whole app. Two environments, because this repo really is
 * two languages' worth of module system: everything under `services/`,
 * `routes/`, `scripts/` and `test/` is CommonJS running in Node, and everything
 * under `public/` is ES modules running in a browser with no bundler.
 *
 * The rule set is deliberately small and bug-focused rather than stylistic.
 * There is no formatter in this project and no `.editorconfig`; a big
 * stylistic pack would flag thousands of lines of working, reviewed code and
 * train everyone to run `--fix` without reading. What is here either catches a
 * real defect (an unused variable is usually a half-finished edit, `eqeqeq`
 * catches the `'' == 0` class of bug in a codebase full of optional numeric
 * fields) or protects an invariant this app depends on.
 */
export default [
  {
    ignores: ['node_modules/**', '.cache/**', 'backups/**', 'bin/**', 'test/fixtures/**'],
  },
  js.configs.recommended,

  // ---------------------------------------------------------------- server --
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      // `ignoreRestSiblings` keeps `({ bytes, ...rest }) => rest` legal — the
      // idiomatic way to drop one key, and how mutationService strips the raw
      // bytes out of a receipt before it goes over the wire.
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true }],
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': ['error', { destructuring: 'all' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },

  // Scripts and tests are allowed to talk to the operator.
  {
    files: ['scripts/**/*.js', 'test/**/*.js', 'server.js'],
    rules: { 'no-console': 'off' },
  },

  // ---------------------------------------------------------------- client --
  {
    files: ['public/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser },
    },
    rules: {
      // `ignoreRestSiblings` keeps `({ bytes, ...rest }) => rest` legal — the
      // idiomatic way to drop one key, and how mutationService strips the raw
      // bytes out of a receipt before it goes over the wire.
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true }],
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': ['error', { destructuring: 'all' }],
      // NOT `no-alert`: that rule also bans `confirm()`, which is this app's
      // documented gate on every destructive write (ui-style-guide §2) and is
      // used seven times on purpose. `alert()` and `prompt()` have no such
      // standing — a mutation reports through `showReceipt`, never a modal.
      'no-restricted-globals': ['error',
        { name: 'alert', message: 'Report through showReceipt() like every other mutation.' },
        { name: 'prompt', message: 'Use a field in the panel; the app has no modal input.' },
      ],
      'no-restricted-properties': ['error', {
        object: 'document',
        property: 'write',
        message: 'Render into `page.innerHTML` like every other module.',
      }],
    },
  },
];
