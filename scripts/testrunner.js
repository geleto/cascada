#!/usr/bin/env node

'use strict';

const NYC = require('nyc');
const path = require('path');

process.env.NODE_ENV = 'test';

const nyc = new NYC({
  cwd: path.join(__dirname, '..'),
  exclude: [
    '*.min.js',
    'scripts/**',
    'tests/**',
    'node_modules/**',
  ],
  reporter: ['text', 'html', 'lcovonly'], // Standard report formats
  all: true, // Ensure all files are instrumented, even those not tested
  tempDirectory: path.join(process.cwd(), '.nyc_output') // Store coverage data
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
    console.log('Writing coverage reports...');
    nyc.writeCoverageFile();
    nyc.report();

    if (err) {
      process.exit(1);
    }
  });
