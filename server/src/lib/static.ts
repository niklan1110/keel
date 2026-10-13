import crypto from 'node:crypto';
import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { config } from './config.js';

export const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.xml': 'application/xml',
  // Installer, keel command and compose files (shown as text, never run by the browser).
  '.sh': 'text/plain; charset=utf-8',
  '.yml': 'text/plain; charset=utf-8',
  '.example': 'text/plain; charset=utf-8',
};

export const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data: blob: http: https:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

// The documentation site is static HTML from our own build. VitePress
// inlines a few small scripts (theme and page data); each page's CSP allows
// exactly those by their hashes, and no other inline script. That matters on
// Studio's port, where the docs share an origin with the signed-in dashboard.
const docsCsp = (scriptSrc: string) =>
  `default-src 'self'; script-src ${scriptSrc}; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'`;
const DOCS_HEADERS: Record<string, string> = { ...SECURITY_HEADERS, 'Content-Security-Policy': docsCsp("'self'") };

const cspCache = new Map<string, { mtime: number; headers: Record<string, string> }>();

/** Headers for one docs file: HTML pages get their inline scripts' hashes. */
async function docsHeaders(file: string, mtime: number): Promise<Record<string, string>> {
  if (!file.endsWith('.html')) return DOCS_HEADERS;
  const hit = cspCache.get(file);
  if (hit && hit.mtime === mtime) return hit.headers;
  const html = await fs.promises.readFile(file, 'utf8');
  const hashes = new Set<string>();
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (/\bsrc\s*=/i.test(m[1])) continue;
    hashes.add(`'sha256-${crypto.createHash('sha256').update(m[2], 'utf8').digest('base64')}'`);
  }
  const headers = { ...SECURITY_HEADERS, 'Content-Security-Policy': docsCsp(["'self'", ...hashes].join(' ')) };
  cspCache.set(file, { mtime, headers });
  return headers;
}

export function sendFile(
  req: IncomingMessage,
  res: ServerResponse,
  file: string,
  size: number,
  status: number,
  headers: Record<string, string>,
  immutable: boolean,
): void {
  res.writeHead(status, {
    'Content-Type': CONTENT_TYPES[path.extname(file)] || 'application/octet-stream',
    'Content-Length': size,
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    ...headers,
  });
  if (req.method === 'HEAD') return void res.end();
  fs.createReadStream(file).pipe(res);
}

export const isDocsPath = (pathname: string) => pathname === '/docs' || pathname.startsWith('/docs/');

/**
 * Serves the documentation under /docs, from both Studio (:3000) and the
 * gateway (:8000). Clean URLs: /docs/guide/quickstart -> guide/quickstart.html,
 * /docs/x/ -> x/index.html; anything else gets the site's 404 page.
 */
export async function serveDocs(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
    return void res.end('Method not allowed');
  }
  if (pathname === '/docs') {
    res.writeHead(301, { Location: '/docs/', 'Cache-Control': 'no-cache' });
    return void res.end();
  }
  const docsRoot = path.resolve(config.docsStatic);
  let rel: string | null;
  try {
    rel = decodeURIComponent(pathname.slice('/docs'.length));
  } catch {
    rel = null;
  }
  const base = rel === null ? null : path.resolve(docsRoot, '.' + rel);
  if (rel !== null && base && (base === docsRoot || base.startsWith(docsRoot + path.sep))) {
    const candidates = rel.endsWith('/') ? [path.join(base, 'index.html')] : [base, base + '.html', path.join(base, 'index.html')];
    for (const file of candidates) {
      const stat = await fs.promises.stat(file).catch(() => null);
      if (stat?.isFile()) return sendFile(req, res, file, stat.size, 200, await docsHeaders(file, stat.mtimeMs), rel.startsWith('/assets/'));
    }
  }
  const notFound = path.join(docsRoot, '404.html');
  const stat = await fs.promises.stat(notFound).catch(() => null);
  if (stat) return sendFile(req, res, notFound, stat.size, 404, await docsHeaders(notFound, stat.mtimeMs), false);
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('The documentation is not built');
}
