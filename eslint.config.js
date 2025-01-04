/* eslint-disable no-undef */

const js = require('@eslint/js');
const globals = require('globals');
const mochaPlugin = require('eslint-plugin-mocha');

// Get mocha recommended config and update its format
const mochaRecommended = {
  ...mochaPlugin.configs.recommended,
  plugins: {
    mocha: mochaPlugin  // Convert plugins array to object format
  },
  languageOptions: {
    globals: {
      ...globals.mocha
    }
  }
};
delete mochaRecommended.env;  // Remove the old env key

module.exports = [
  js.configs.recommended,
  {
    ignores: [
      '**/*.min.js',
      '**/*.bundle.js',
      'node_modules/**',
      'coverage/**',
      'dist/**',
      'docs/**',
      'bench/**',
      'tests/browser/precompiled-templates.js'
    ]
  },
  mochaRecommended,
  {
    files: ['nunjucks/**/*.js', 'scripts/**/*.js', 'tests/**/*.js'],
    plugins: {
      mocha: mochaPlugin
    },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        __dirname: 'readonly',
        __filename: 'readonly',
        exports: 'writable',
        module: 'readonly',
        require: 'readonly',
        nunjucks: 'readonly',
        ...globals.browser,
        ...globals.node,
        ...globals.mocha
      }
    },
    rules: {
      // Spacing and Formatting
      'indent': ['error', 2, { 'SwitchCase': 1 }],
      'space-before-blocks': ['error', 'always'],
      /*'space-before-function-paren': ['error', {
        anonymous: 'always',
        named: 'never',
        asyncArrow: 'always'
      }],*/
      'space-in-parens': ['error', 'never'],
      'space-infix-ops': 'error',
      'keyword-spacing': ['error', { before: true, after: true }],
      'array-bracket-spacing': ['error', 'never'],
      //'object-curly-spacing': ['error', 'always'],
      'comma-spacing': ['error', { before: false, after: true }],
      'no-trailing-spaces': 'error',
      'eol-last': 'error',
      'quotes': ['error', 'single', { allowTemplateLiterals: true }],
      'semi': ['error', 'always'],

      // Best Practices
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
      'no-undef': 'error',
      'no-console': ['warn', { allow: ['error', 'warn'] }],
      'no-debugger': 'error',
      'no-duplicate-imports': 'error',
      //'no-var': 'error',
      //'prefer-const': 'error',
      //'no-multiple-empty-lines': ['error', { max: 1, maxEOF: 0 }],
      'camelcase': 'error',
      'dot-notation': 'error',
      //'eqeqeq': ['error', 'always'],
      //'no-else-return': 'error',
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-return-await': 'error',
      'no-self-compare': 'error',
      'no-throw-literal': 'error',
      'no-useless-catch': 'error',
      'no-useless-return': 'error',
      'prefer-promise-reject-errors': 'error',
      'no-shadow': 'error',
      //'no-use-before-define': ['error', { functions: false }],

      // ES6+
      'arrow-spacing': 'error',
      'no-confusing-arrow': 'error',
      //'no-duplicate-imports': 'error',
      'no-useless-computed-key': 'error',
      'no-useless-constructor': 'error',
      'no-useless-rename': 'error',
      'no-useless-escape': 'off',
      //'no-var': 'error',
      //'object-shorthand': 'error',
      //'prefer-arrow-callback': 'error',
      //'prefer-const': 'error',
      //'prefer-rest-params': 'error',
      'prefer-spread': 'error',
      'rest-spread-spacing': ['error', 'never'],

      'no-new-wrappers': 'error',
      'no-array-constructor': 'error',
      'vars-on-top': 'error',

      'mocha/consistent-spacing-between-blocks': 'off',
      'mocha/no-setup-in-describe': 'off',
      'mocha/no-mocha-arrows': 'off',
      'mocha/no-exports': 'off',
      'mocha/no-skipped-tests': 'off',
      'mocha/no-top-level-hooks': 'off',
    }
  }
];