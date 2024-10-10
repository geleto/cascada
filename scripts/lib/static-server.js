const connect = require('connect');
const getPort = require('get-port');
const serveStatic = require('serve-static');
const http = require('http');
const path = require('path');
const fs = require('fs');
const babel = require('@babel/core');
const url = require('url');

function getStaticServer(prt) {
  const staticRoot = path.join(__dirname, '../..');
  const portPromise = typeof prt === 'undefined' ? getPort() : Promise.resolve(prt);

  return portPromise.then((port) => {
    return new Promise((resolve, reject) => {
      try {
        const app = connect();

        // Middleware to instrument JS files on-the-fly using Babel
        app.use((req, res, next) => {
          const parsedUrl = url.parse(req.url);
          const pathname = parsedUrl.pathname;

          // Resolve the file path
          const filePath = path.join(staticRoot, pathname);

          // Always serve non-JS files and minified JS files without instrumentation
          if (!pathname.endsWith('.js') || pathname.endsWith('.min.js')) {
            return serveStatic(staticRoot)(req, res, next);
          }

          // Conditional instrumentation: Only instrument JS files that meet certain conditions
          if (
            !filePath.includes('node_modules') // && // Don't instrument files from node_modules
            // !filePath.includes('tests/browser') // Don't instrument test libraries
          ) {
            // Read and instrument the JS file using Babel
            fs.readFile(filePath, 'utf8', (err, code) => {
              if (err) return next(err);

              babel.transform(
                code,
                {
                  filename: filePath,
                  sourceMaps: 'inline',
                  babelrc: true, // Ensure Babel uses .babelrc
                  envName: 'test', // Set the environment to 'test'
                },
                (error, result) => {
                  if (error) {
                    console.error('Babel transform error:', error);
                    return next(err);
                  }

                  // console.log(`Instrumented ${filePath}:\n`,
                  // result.code.split('\n').slice(0, 5).join('\n'));
                  res.setHeader('Content-Type', 'application/javascript');
                  res.end(result.code);
                  return undefined;
                }
              );
              return undefined;
            });
          } else {
            // Serve the JS file without instrumentation
            return serveStatic(staticRoot)(req, res, next);
          }
          return undefined;
        });

        // Serve static files (HTML, CSS, images, etc.)
        app.use(serveStatic(staticRoot));

        const server = http.createServer(app);
        server.listen(port, () => {
          console.log('Test server listening on port ' + port);
          resolve([server, port]);
        });
      } catch (e) {
        reject(e);
      }
    });
  });
}

module.exports = getStaticServer;
