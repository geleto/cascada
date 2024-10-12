#!/usr/bin/env node

'use strict';

const precompileTestTemplates = require('./lib/precompile');

precompileTestTemplates()
  .then(() => {
    console.log('Precompilation complete.');
  })
  .catch((err) => {
    console.error('Precompilation failed:', err);
    process.exit(1);
  });
