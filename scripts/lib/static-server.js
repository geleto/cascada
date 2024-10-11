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
          const filePath = path.join(staticRoot, pathname);

          console.log(`Requested file: ${filePath}`); // Debugging log

          // Always serve non-JS files and minified JS files without instrumentation
          if (!pathname.endsWith('.js') || pathname.endsWith('.min.js')) {
            return next();
          }

          // Conditional instrumentation
          if (!filePath.includes('node_modules')) {
            fs.readFile(filePath, 'utf8', (err, code) => {
              if (err) {
                console.error(`Error reading file ${filePath}:`, err);
                return next(); // Proceed to the next middleware
              }

              babel.transform(
                code,
                {
                  filename: filePath,
                  sourceMaps: 'inline',
                  babelrc: true,
                  envName: 'test',
                },
                (error, result) => {
                  if (error) {
                    console.error('Babel transform error:', error);
                    return next(); // Proceed to the next middleware
                  }

                  res.setHeader('Content-Type', 'application/javascript');
                  res.end(result.code);
                  return undefined;
                }
              );
              return undefined;
            });
          } else {
            return next();
          }
          return undefined;
        });

        // Serve static files (HTML, CSS, images, etc.) with correct MIME types
        app.use(
          serveStatic(staticRoot, {
            setHeaders: (res, filePath) => {
              if (filePath.endsWith('.js') || filePath.endsWith('.min.js')) {
                res.setHeader('Content-Type', 'application/javascript');
              }
            },
          })
        );

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
