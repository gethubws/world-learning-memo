import { createServer } from 'node:http';
import { stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createAiMiddleware } from './ai.ts';

const root = path.resolve(fileURLToPath(new URL('../dist/', import.meta.url)));
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
const ai = createAiMiddleware();
const types: Record<string, string> = {
  '.html': 'text/html;charset=utf-8',
  '.js': 'text/javascript;charset=utf-8',
  '.css': 'text/css;charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};
await stat(path.join(root, 'index.html')).catch(() => {
  throw new Error('请先运行 npm run build');
});
const server = createServer((req, res) => {
  void ai.handler(req, res, () => {
    void (async () => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405);
        res.end();
        return;
      }
      let relative: string;
      try {
        relative = decodeURIComponent(
          new URL(req.url || '/', 'http://localhost').pathname,
        );
      } catch {
        res.writeHead(400);
        res.end();
        return;
      }
      const file = path.resolve(
        root,
        '.' + (relative === '/' ? '/index.html' : relative),
      );
      if (
        !file.startsWith(root + path.sep) &&
        file !== path.join(root, 'index.html')
      ) {
        res.writeHead(403);
        res.end();
        return;
      }
      try {
        if (!(await stat(file)).isFile()) throw new Error();
        res.writeHead(200, {
          'Content-Type':
            types[path.extname(file)] || 'application/octet-stream',
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'same-origin',
          'Content-Security-Policy':
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
          'Cache-Control': relative.startsWith('/assets/')
            ? 'public,max-age=31536000,immutable'
            : 'no-cache',
        });
        if (req.method === 'HEAD') {
          res.end();
          return;
        }
        createReadStream(file)
          .on('error', () => res.destroy())
          .pipe(res);
      } catch {
        res.writeHead(404);
        res.end('Not found');
      }
    })();
  });
});
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
server.listen(port, host, () =>
  console.log(`Local: http://localhost:${port}/`),
);
const close = () => {
  ai.close();
  server.close();
};
process.on('SIGINT', close);
process.on('SIGTERM', close);
