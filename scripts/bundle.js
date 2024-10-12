#!/usr/bin/env node

'use strict';

const path = require('path');
const webpack = require('webpack');
const pjson = require('../package.json');
const promiseSequence = require('./lib/utils').promiseSequence;
const TerserPlugin = require('terser-webpack-plugin');
const TEST_ENV = process.env.NODE_ENV === 'test';

const destDir = path.resolve(path.join(__dirname, TEST_ENV ? '../tests/browser' : '../browser'));

function runWebpack(opts) {
  const type = opts.slim ? '(slim, only works with precompiled templates)' : '';
  let ext = opts.min ? '.min.js' : '.js';
  if (opts.slim) {
    ext = `-slim${ext}`;
  }
  const filename = `nunjucks${ext}`;

  return new Promise((resolve, reject) => {
    try {
      const config = {
        entry: './nunjucks/index.js',
        devtool: 'source-map',
        output: {
          path: destDir,
          filename: filename,
          library: 'nunjucks',
          libraryTarget: 'umd',
          devtoolModuleFilenameTemplate:
            (info) => path.relative(destDir, info.absoluteResourcePath),
        },
        node: {
          process: false,
          setImmediate: false,
        },
        module: {
          rules: [
            {
              test: /nunjucks/,
              exclude: /(node_modules|browser|tests)(?!\.js)/,
              use: {
                loader: 'babel-loader',
                options: {
                  plugins: [
                    [
                      'module-resolver',
                      {
                        extensions: ['.js'],
                        resolvePath: (sourcePath) => {
                          if (sourcePath.match(/^(fs|path|chokidar)$/)) {
                            return 'node-libs-browser/mock/empty';
                          }
                          if (opts.slim) {
                            if (sourcePath.match(/(nodes|lexer|parser|precompile|transformer|compiler)(\.js)?$/)) {
                              return 'node-libs-browser/mock/empty';
                            }
                          }
                          if (sourcePath.match(/\/loaders(\.js)?$/)) {
                            return sourcePath.replace('loaders', opts.slim ? 'precompiled-loader' : 'web-loaders');
                          }
                          return null;
                        },
                      },
                    ],
                  ],
                  ...(TEST_ENV && {
                    plugins: ['babel-plugin-istanbul'],
                  }),
                },
              },
            },
          ],
        },
        plugins: [
          new webpack.BannerPlugin(`Browser bundle of nunjucks ${pjson.version} ${type}`),
          new webpack.DefinePlugin({
            'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'production'),
            'process.env.BUILD_TYPE': JSON.stringify(opts.slim ? 'SLIM' : 'STD'),
          }),
        ],
        optimization: {
          minimize: opts.min,
          minimizer: [
            new TerserPlugin({
              terserOptions: {
                mangle: {
                  properties: {
                    regex: /^_[^_]/,
                  },
                },
                compress: {
                  unsafe: true,
                },
              },
              extractComments: false,
            }),
          ],
        },
      };

      webpack(config).run((err, stats) => {
        if (err) {
          reject(err);
        } else {
          resolve(stats.toString({ cached: false, cachedAssets: false }));
        }
      });
    } catch (err) {
      reject(err);
    }
  });
}

const runConfigs = [
  { min: true, slim: false },
  { min: true, slim: true },
];

if (!TEST_ENV) {
  runConfigs.unshift({ min: false, slim: false }, { min: false, slim: true });
}

const promises = runConfigs.map((opts) =>
  () => runWebpack(opts).then((stats) => console.log(stats))
);

promiseSequence(promises).catch((err) => {
  throw err;
});