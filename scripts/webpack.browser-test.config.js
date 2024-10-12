const path = require('path');

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
          path.resolve(__dirname, '../nunjucks'),
          path.resolve(__dirname, '../tests'),
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
