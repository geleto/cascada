#!/usr/bin/env node
import {precompileTestTemplates} from './lib/precompile.js';

precompileTestTemplates()
  .then(() => {
  })
  .catch((err) => {
    console.error('Precompilation failed:', err);
    process.exit(1);
  });
