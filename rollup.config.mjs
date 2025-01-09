import commonjs from '@rollup/plugin-commonjs';
import nodeResolve from '@rollup/plugin-node-resolve';
import babel from '@rollup/plugin-babel';
import json from '@rollup/plugin-json';
//import { terser } from 'rollup-plugin-terser';

export default {
  input: 'nunjucks/index.js',
  plugins: [
    nodeResolve({
      preferBuiltins: true, // Change to "true" if you want to use Node.js built-ins
    }),
    commonjs(),
    json(), // Add this to handle JSON imports
    babel({
      babelHelpers: 'bundled',
      exclude: 'node_modules/**',
      // If you want to use the same .babelrc, you can omit 'presets' here
      // and let Babel find your .babelrc automatically.
      // Or you can specify the same config here if you like:
      // presets: [
      //   [
      //     '@babel/preset-env',
      //     {
      //       loose: true,
      //       targets: {
      //         browsers: [">0.2%", "not dead", "not op_mini all"],
      //         node: "current"
      //       }
      //     }
      //   ]
      // ],
    }),
    //terser(), // Add this plugin for minification
  ],
  external: [
    'path',
    'domain',
    'fs',
    'stream',
    'os'
  ],
  output: [
    {
      file: 'dist/cascada.esm.js',
      format: 'es',
    },
  ],
};
