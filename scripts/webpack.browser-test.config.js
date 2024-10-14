const path = require('path');
const webpack = require('webpack');
const NodePolyfillPlugin = require('node-polyfill-webpack-plugin');

module.exports = {
  mode: 'development',
  entry: {
    nunjucks: './nunjucks/index.js',
    tests: './tests/browser/index.js',
  },
  output: {
    path: path.resolve(__dirname, '../tests/browser/dist'),
    filename: '[name].bundle.js',
    library: {
      name: 'nunjucks',
      type: 'umd',
    },
    clean: true,
  },
  devtool: 'source-map',
  module: {
    rules: [
      {
        test: /\.js$/,
        include: [
          path.resolve(__dirname, '../nunjucks/src'),
        ],
        use: {
          loader: 'babel-loader',
          options: {
            plugins: ['babel-plugin-istanbul']
          }
        }
      }
    ]
  },
  plugins: [
    new NodePolyfillPlugin(),
  ],
  resolve: {
    alias: {
      // Add alias for dummy-pkg
      'dummy-pkg': path.resolve(__dirname, '../tests/test-node-pkgs/dummy-pkg'),
      'nunjucks/src/node-loaders': false, // no node loaders in browser environment
    },
    fallback: {
      "path": require.resolve("path-browserify"),
      "fs": false,
      "os": require.resolve("os-browserify/browser"),
      "stream": require.resolve("stream-browserify")
    }
  },
  optimization: {
    moduleIds: 'deterministic',
    splitChunks: {
      cacheGroups: {
        vendor: {
          test: /[\\/]node_modules[\\/]/,
          name: 'vendors',
          chunks: 'all',
        },
      },
    },
  },
};

// Only add the IgnorePlugin for fsevents on non-macOS platforms
// to avoid Can't resolve 'fsevents' in chokidar
if (process.platform !== "darwin") {
  module.exports.plugins.push(
    new webpack.IgnorePlugin({
      resourceRegExp: /^fsevents$/,
    })
  );
}