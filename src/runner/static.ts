import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, resolve } from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
};

export interface StaticServer {
  url: string;
  close(): Promise<void>;
  server: Server;
}

/** Serves one directory on the loopback interface only. Port 0 picks a free port. */
export async function serveDirectory(dir: string, port = 0): Promise<StaticServer> {
  const root = resolve(dir);
  const server = createServer(async (req, res) => {
    let path: string;
    try {
      path = decodeURIComponent(new URL(req.url ?? '/', 'http://local').pathname);
    } catch {
      res.writeHead(400).end('bad request');
      return;
    }
    const file = resolve(join(root, normalize(path)));
    if (file !== root && !file.startsWith(root + '/')) {
      res.writeHead(403).end();
      return;
    }
    const info = await stat(file).catch(() => null);
    const target = info?.isDirectory() ? join(file, 'index.html') : file;
    if (!(await stat(target).catch(() => null))?.isFile()) {
      res.writeHead(404).end('not found');
      return;
    }
    // A symbolic link must not lead out of the folder being served.
    const real = await realpath(target);
    if (!real.startsWith((await realpath(root)) + '/')) {
      res.writeHead(403).end();
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[extname(target)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    createReadStream(target).pipe(res);
  });
  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', ok);
  });
  const { port: bound } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${bound}/`,
    server,
    close: () => new Promise((ok) => {
      server.closeAllConnections();
      server.close(() => ok());
    }),
  };
}
