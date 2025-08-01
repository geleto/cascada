#!/usr/bin/env node

'use strict';

const path = require('path');
const webpack = require('webpack');
const pjson = require('../package.json');
const promiseSequence = require('./lib/utils').promiseSequence;
const TerserPlugin = require('terser-webpack-plugin');
const TEST_ENV = process.env.NODE_ENV === 'test';

const destDir = path.resolve(path.join(__dirname, TEST_ENV ? '../tests/browser' : '../dist/browser'));

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
        mode: TEST_ENV ? 'development' : (process.env.NODE_ENV || 'production'),
        entry: './src/index.js',
        target: 'web',
        devtool: TEST_ENV ? 'inline-source-map' : 'source-map',
        output: {
          path: destDir,
          filename: filename,
          library: 'nunjucks',
          libraryTarget: 'umd',
          globalObject: 'this',
          devtoolModuleFilenameTemplate:
            (info) => path.relative(destDir, info.absoluteResourcePath),
        },
        resolve: {
          fallback: {
            'fs': false,
            'path': false,
            'os': false,
            'chokidar': false,
            'stream': false
          }
        },
        module: {
          rules: [
            {
              test: /src/,
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
                          if (sourcePath.match(/^(fs|path|os|chokidar|stream)$/)) {
                            return 'node-libs-browser/mock/empty';
                          }
                          if (opts.slim) {
                            if (sourcePath.match(/(nodes|lexer|parser|precompile|transformer|compiler)(\.js)?$/)) {
                              return 'node-libs-browser/mock/empty';
                            }
                          }
                          if (sourcePath.match(/(^|\/)loaders(\.js)?$/)) {
                            return sourcePath.replace(/loaders(\.js)?$/, opts.slim ? 'precompiled-loader$1' : 'web-loaders$1');
                          }
                          return null;
                        },
                      },
                    ],
                    ...(TEST_ENV ? ['babel-plugin-istanbul'] : []),
                  ],
                },
              },
            },
          ],
        },
        plugins: [
          new webpack.BannerPlugin(`Browser bundle of nunjucks ${pjson.version} ${type}`),
          new webpack.DefinePlugin({
            'process.env.NODE_ENV': JSON.stringify(TEST_ENV ? 'development' : (process.env.NODE_ENV || 'production')),
            'process.env.BUILD_TYPE': JSON.stringify(opts.slim ? 'SLIM' : 'STD'),
          }),
          new webpack.IgnorePlugin({
            resourceRegExp: /^fsevents$/,
            contextRegExp: /chokidar/,
          }),
        ],
        optimization: {
          minimize: opts.min && !TEST_ENV,
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
  // eslint-disable-next-line no-console
  () => runWebpack(opts).then((stats) => console.log(stats))
);

promiseSequence(promises).catch((err) => {
  throw err;
});
