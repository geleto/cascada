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

          // Only instrument JS files that are part of your source code
          if (pathname.endsWith('.js')) {
            const filePath = path.join(staticRoot, pathname);

            // Exclude files in node_modules or any minified files
            if (
              filePath.includes('node_modules') ||
              filePath.includes('tests/browser') || // Exclude test libraries
              filePath.endsWith('.min.js')
            ) {
              // Serve the file without instrumentation
              return serveStatic(staticRoot)(req, res, next);
            }

            fs.readFile(filePath, 'utf8', (err, code) => {
              if (err) return next(err);

              babel.transform(
                code,
                {
                  filename: filePath,
                  sourceMaps: 'inline',
                  plugins: ['istanbul'],
                },
                (error, result) => {
                  if (error) return next(err);

                  res.setHeader('Content-Type', 'application/javascript');
                  res.end(result.code);

                  return undefined;
                }
              );

              return undefined;
            });
          } else {
            next();
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
