/**
 * 本地预览用的静态服务器。
 *
 * 线上由 GitHub Actions 把 web/ 和 data/ 拼成一个站点目录再发布，
 * 这里做同样的拼接，保证本地看到的和线上一致：
 *   /            → web/
 *   /data/...    → data/
 */
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { ROOT } from '../pipeline/util.js';

const PORT = Number(process.env.PORT ?? 4173);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

function resolve(urlPath) {
  // 挡掉 ../ 越权访问
  const clean = normalize(decodeURIComponent(urlPath.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  if (clean === '/' || clean === '') return join(ROOT, 'web', 'index.html');
  if (clean.startsWith('/data/')) return join(ROOT, clean);
  return join(ROOT, 'web', clean);
}

createServer(async (req, res) => {
  const file = resolve(req.url ?? '/');
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}).listen(PORT, () => {
  console.log(`\n本地预览：http://localhost:${PORT}\n手机同局域网可用本机 IP 访问同一端口\n`);
});
