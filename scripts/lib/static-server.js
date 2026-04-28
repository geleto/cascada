import connect from 'connect';
import serveStatic from 'serve-static';
import http from 'http';
import net from 'net';
import path from 'path';
import {promises as fs} from 'fs';
import babel from '@babel/core';
import {fileURLToPath} from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const logMissingFiles = process.env.CASCADA_TEST_SERVER_LOG_404 === '1';

async function findAvailablePort(startPort = 3000) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.listen(startPort, () => {
      const port = server.address().port;
      server.close(() => {
        resolve(port);
      });
    });

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        // Port is in use, try the next one
        resolve(findAvailablePort(startPort + 1));
      } else {
        reject(err);
      }
    });
  });
}

async function getStaticServer(prt) {
  const staticRoot = path.join(scriptDir, '../..');
  const port = typeof prt === 'undefined' ? await findAvailablePort() : prt;

  try {
    const app = connect();

    // Middleware to handle all requests
    app.use(async (req, res, next) => {
      const {pathname} = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
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

          const shouldInstrument =
            process.env.NODE_ENV === 'test' &&
            pathname.startsWith('/src/') &&
            pathname.endsWith('.js');

          if (shouldInstrument) {
            const code = await fs.readFile(filePath, 'utf8');
            const result = await babel.transformAsync(code, {
              filename: filePath,
              sourceMaps: 'inline',
              babelrc: false,
              configFile: false,
              plugins: ['babel-plugin-istanbul'],
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
          if (logMissingFiles) {
            console.error(`File not found: ${filePath}`);
          }
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

export {getStaticServer};
