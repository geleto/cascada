#!/usr/bin/env node

'use strict';

const NYC = require('nyc');
const path = require('path');

process.env.NODE_ENV = 'test';

const nyc = new NYC({
  cwd: path.join(__dirname, '..'),
  exclude: [
    '*.min.js',
    'scripts/**', // Exclude the scripts directory
    'tests/**',
    'node_modules/**'
  ],
  reporter: ['text', 'html', 'lcovonly'],
  all: true,
});

nyc.reset();

require('@babel/register');

const runtests = require('./lib/runtests');
const precompileTestTemplates = require('./lib/precompile');

let err;

precompileTestTemplates()
  .then(() => runtests())
  .catch((e) => {
    err = e;
    console.error(err);
  })
  .then(() => {
    nyc.writeCoverageFile();
    nyc.report();

    if (err) {
      process.exit(1);
    }
  });
