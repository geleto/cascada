const js = require('@eslint/js');
const globals = require('globals');
//const pluginNode = require('eslint-plugin-node');

// https://github.com/sindresorhus/globals/issues/239
const GLOBALS_BROWSER_FIX = Object.assign({}, globals.browser, {
  //AudioWorkletGlobalScope: globals.browser['AudioWorkletGlobalScope ']
});
delete GLOBALS_BROWSER_FIX['AudioWorkletGlobalScope '];

module.exports = [
  {
    ...js.configs.recommended,
    rules: {
      ...js.configs.recommended.rules,
      //@todo - fix these
      'no-undef': 'off',
      'no-unused-vars': 'off',
      'no-redeclare': 'off',
      'no-prototype-builtins': 'off',
      'no-useless-escape': 'off',
      'no-empty': 'off',
      'no-constant-condition': 'off',
      'no-cond-assign': 'off',
      'no-func-assign': 'off',
      'no-fallthrough': 'off',
      'no-control-regex': 'off',
      'no-misleading-character-class': 'off',
    }
  },
  //pluginNode.configs['recommended'],
  {
    ignores: ['**/*.min.js', '**/*.bundle.js'],
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        // Node.js globals
        __dirname: 'readonly',
        __filename: 'readonly',
        exports: 'writable',
        module: 'readonly',
        require: 'readonly',
        // Your custom global
        nunjucks: 'readonly',
        ...GLOBALS_BROWSER_FIX,
        ...globals.node
      }
    },
    rules: {
      // The one assertion of personal preference: no spaces before parentheses
      // of anonymous functions
      'space-before-function-paren': ['error', {
        anonymous: 'never',
        named: 'never',
        asyncArrow: 'always',
      }],

	    'no-console': ['warn', { allow: ['error'] }],
      'no-self-compare': 'error',
      'dot-notation': 'error',
      'guard-for-in': 'error',
      'no-restricted-syntax': ['error'],
      'no-nested-ternary': 'error',
      'for-direction': 'error',
      'camelcase': 'error',
      'no-constant-condition': 'error',
      'consistent-return': 'error',
      'no-undefined': 'off',
      'no-undef': 'off',
      'no-new-wrappers': 'error',
      'no-array-constructor': 'error',
      'vars-on-top': 'error',
      'no-shadow': 'error',
      'no-eval': 'error',

      /*'node/no-deprecated-api': 'error',
      'node/no-missing-import': 'error',
      'node/no-unpublished-import': 'error',
      'node/no-extraneous-import': 'error',*/

      'quotes': ['error', 'single', { 'allowTemplateLiterals': true }],
      'linebreak-style': 'off',
      'no-use-before-define': 'off',
      'no-cond-assign': ['error', 'except-parens'],
      'no-unused-vars': ['error', {
        'args': 'none',
        'caughtErrors': 'none'
      }],
      'no-underscore-dangle': 'off',
      'no-param-reassign': 'off',
      'class-methods-use-this': 'off',
      'function-paren-newline': 'off',
      'no-plusplus': 'off',
      'object-curly-spacing': 'off',
      'no-multi-assign': 'off',
      'no-else-return': 'off',
      'no-useless-escape': 'off',
      'comma-dangle': 'off',
    },
    ignores: [
      'node_modules/**',
      'spm_modules/**',
      'coverage/**',
      'dist/**',
      'browser/**',
      'docs/**',
      'tests/express-sample/**',
      'tests/express/**',
      'tests/browser/**',
      'bench/**',
      'src/loaders.js',
    ],
  },
];
