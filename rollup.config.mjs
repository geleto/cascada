import commonjs from '@rollup/plugin-commonjs';
import nodeResolve from '@rollup/plugin-node-resolve';
import json from '@rollup/plugin-json';

export default {
  input: {
    'index': 'src/index.mjs'
  },
  plugins: [
    nodeResolve({
      preferBuiltins: true,
    }),
    commonjs({
      // ensure named exports are preserved
      exportType: 'named',
      transformMixedEsModules: true,
      requireReturnsDefault: true
    }),
    json(),
  ],
  external: [
    // Node builtins
    'path',
    'domain',
    'fs',
    'stream',
    'os',
    // Mark all node_modules as external
    /^node_modules/,
  ],
  output: {
    dir: 'dist/esm',
    format: 'es',
    sourcemap: true,
    exports: 'named',
    entryFileNames: '[name].mjs'
  },
  onwarn(warning, warn) {
    if (warning.code === 'CIRCULAR_DEPENDENCY') {
      // These are safe: lazy-loaded in constructors for backwards compatibility
      // The require() happens inside init(), not at module level
      if (/environment\/environment\.js.*template\.js/i.test(warning.message) ||
          /environment\/environment\.js.*context\.js/i.test(warning.message)) {
        return;
      }
    }
    warn(warning);
  }
};