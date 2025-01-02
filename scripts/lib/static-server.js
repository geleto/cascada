const connect = require('connect');
const getPort = require('get-port');
const serveStatic = require('serve-static');
const http = require('http');
const path = require('path');
const fs = require('fs').promises;
const babel = require('@babel/core');
const url = require('url');

async function getStaticServer(prt) {
  const staticRoot = path.join(__dirname, '../..');
  const port = typeof prt === 'undefined' ? await getPort() : prt;

  try {
    const app = connect();

    // Middleware to handle all requests
    app.use(async (req, res, next) => {
      const parsedUrl = url.parse(req.url);
      const pathname = parsedUrl.pathname;
      const filePath = path.join(staticRoot, pathname);

      try {
        const stats = await fs.stat(filePath);

        if (stats.isFile()) {
          // Set correct MIME type for all files
          if (pathname.endsWith('.js') || pathname.endsWith('.min.js')) {
            res.setHeader('Content-Type', 'application/javascript');
          } else if (pathname.endsWith('.html')) {
            res.setHeader('Content-Type', 'text/html');
          } else if (pathname.endsWith('.css')) {
            res.setHeader('Content-Type', 'text/css');
          }

          // For JS files that are not in node_modules and not minified, apply Babel transform
          if (pathname.endsWith('.js') && !pathname.endsWith('.min.js') && !filePath.includes('node_modules')) {
            const code = await fs.readFile(filePath, 'utf8');
            const result = await babel.transformAsync(code, {
              filename: filePath,
              sourceMaps: 'inline',
              babelrc: true,
              envName: 'test',
            });

            if (!result || !result.code) {
              throw new Error('Babel transform resulted in null or undefined code');
            }

            res.end(result.code);
          } else {
            // For all other files, serve them directly
            const fileContent = await fs.readFile(filePath);
            res.end(fileContent);
          }
        } else {
          // If it's not a file, move to the next middleware
          next();
        }
      } catch (error) {
        if (error.code === 'ENOENT') {
          // File not found
          console.error(`File not found: ${filePath}`);
          res.statusCode = 404;
          res.setHeader('Content-Type', 'text/plain');
          res.end('404 Not Found');
        } else {
          console.error(`Error processing file ${filePath}:`, error);
          res.statusCode = 500;
          res.setHeader('Content-Type', 'text/plain');
          res.end('500 Internal Server Error');
        }
      }
    });

    // Fallback static file serving
    app.use(serveStatic(staticRoot));

    return new Promise((resolve) => {
      const server = http.createServer(app);
      server.listen(port, () => {
        // eslint-disable-next-line no-console
        console.log('Test server listening on port ' + port);
        resolve([server, port]);
      });
    });
  } catch (e) {
    console.error('Error setting up server:', e);
    throw e;
  }
}

module.exports = getStaticServer;
