const js = require('@eslint/js');
const globals = require('globals');
const mochaPlugin = require('eslint-plugin-mocha');

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
     'bench/**'
   ]
 },
 {
   files: ['**/*.js'],
   plugins: {
     mocha: mochaPlugin
   },
   extends: ['plugin:mocha/recommended'],
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
       ...globals.node
     }
   },
   rules: {
     // Spacing and Formatting
     'indent': ['error', 2, { 'SwitchCase': 1 }],
     'space-before-blocks': ['error', 'always'],
     'space-before-function-paren': ['error', {
       anonymous: 'always',
       named: 'never',
       asyncArrow: 'always'
     }],
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
     'rest-spread-spacing': ['error', 'never']
   }
 }
];