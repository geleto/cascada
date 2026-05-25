import fs from 'fs';
import http from 'http';
import path from 'path';
import {fileURLToPath} from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '../generated-docs/script');
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8'
};

function resolveRequestPath(urlPath) {
  const decodedPath = decodeURIComponent(urlPath);
  const requestPath = decodedPath === '/' ? '/index.html' : decodedPath;
  const filePath = path.resolve(rootDir, `.${requestPath}`);

  if (!filePath.startsWith(`${rootDir}${path.sep}`) && filePath !== rootDir) {
    return null;
  }

  return filePath;
}

function sendFile(res, filePath) {
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, {'content-type': 'text/plain; charset=utf-8'});
      res.end('Not found');
      return;
    }

    const contentType = contentTypes[path.extname(filePath)] || 'application/octet-stream';
    res.writeHead(200, {'content-type': contentType});
    res.end(content);
  });
}

const server = http.createServer((req, res) => {
  const requestUrl = new URL(req.url, `http://${host}:${port}`);
  const filePath = resolveRequestPath(requestUrl.pathname);

  if (!filePath) {
    res.writeHead(403, {'content-type': 'text/plain; charset=utf-8'});
    res.end('Forbidden');
    return;
  }

  sendFile(res, filePath);
});

server.listen(port, host, () => {
  console.log(`Serving generated docs at http://${host}:${port}/`);
});
