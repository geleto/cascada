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

    // Middleware to instrument JS files on-the-fly using Babel
    app.use(async (req, res, next) => {
      const parsedUrl = url.parse(req.url);
      const pathname = parsedUrl.pathname;
      const filePath = path.join(staticRoot, pathname);

      //console.log(`Requested file: ${filePath}`); // Debugging log

      // Always serve non-JS files and minified JS files without instrumentation
      if (!pathname.endsWith('.js') || pathname.endsWith('.min.js')) {
        return next();
      }

      // Conditional instrumentation
      let code;
      if (!filePath.includes('node_modules')) {
        try {
          code = await fs.readFile(filePath, 'utf8');
          const result = await babel.transformAsync(code, {
            filename: filePath,
            sourceMaps: 'inline',
            babelrc: true,
            envName: 'test',
          });

          if (!result || !result.code) {
            throw new Error('Babel transform resulted in null or undefined code');
          }

          res.setHeader('Content-Type', 'application/javascript');
          res.end(result.code);
        } catch (error) {
          console.error(`Error processing file ${filePath}:`, error);
          console.error('Code snippet:', (code?code.substring(0, 100):'') + '...');
          next();
        }
      } else {
        next();
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