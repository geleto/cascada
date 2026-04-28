import http from 'http';
import net from 'net';
import path from 'path';
import {promises as fs} from 'fs';
import babel from '@babel/core';
import {fileURLToPath} from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const logMissingFiles = process.env.CASCADA_TEST_SERVER_LOG_404 === '1';
const serveDistForSrc = process.env.CASCADA_TEST_DIST === '1';

function getContentType(pathname) {
  if (pathname.endsWith('.js') || pathname.endsWith('.min.js')) {
    return 'application/javascript';
  }
  if (pathname.endsWith('.html')) {
    return 'text/html';
  }
  if (pathname.endsWith('.css')) {
    return 'text/css';
  }
  if (pathname.endsWith('.json')) {
    return 'application/json';
  }
  return null;
}

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
    const app = async (req, res) => {
      const {pathname} = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const servedPathname = serveDistForSrc && pathname.startsWith('/src/')
        ? `/dist/${pathname.slice('/src/'.length)}`
        : pathname;
      const filePath = path.join(staticRoot, servedPathname);

      try {
        const stats = await fs.stat(filePath);

        if (stats.isFile()) {
          const contentType = getContentType(pathname);
          if (contentType) {
            res.setHeader('Content-Type', contentType);
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
          res.statusCode = 404;
          res.setHeader('Content-Type', 'text/plain');
          res.end('404 Not Found');
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
    };

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
