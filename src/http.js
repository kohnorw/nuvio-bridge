// The web layer, on node's own http server.
//
// This used to be Express plus cookie-parser: sixty-odd packages, an npm
// install in every image build, and a lock file to keep honest — for routing,
// cookies, a JSON body parser and a static handler. All four are small, and
// none of them is where this app's difficulty lives.
//
// So they're here instead, and the container now has no dependencies at all.
// The build is a COPY and nothing else.
//
// The shape of the API is deliberately Express's, because the routes in
// server.js were written against it and rewriting nine hundred lines to save
// two megabytes would be a poor trade. What is implemented is exactly what
// those routes use — no more. `req` and `res` are node's own objects with
// methods added rather than wrappers around them, which is what lets the
// media proxy keep piping a stream straight into the response.

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';

const gzip = promisify(zlib.gzip);

const BODY_LIMIT = 1024 * 1024;
const COMPRESS_MIN = 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.m3u': 'audio/x-mpegurl',
  '.m3u8': 'application/vnd.apple.mpegurl',
  // HLS segments. Without this they go out as application/octet-stream, which
  // hls.js tolerates but Safari's native HLS does not.
  '.ts': 'video/mp2t',
  // HLS fragmented-MP4 pieces: the init segment carries the codec
  // configuration and the rest are media fragments.
  '.mp4': 'video/mp4',
  '.m4s': 'video/iso.segment',
  '.vtt': 'text/vtt; charset=utf-8',
  '.sup': 'application/octet-stream',
};

// Compressing a JPEG wastes CPU to make the file bigger. Only text.
const COMPRESSIBLE = /^(text\/|application\/(json|javascript|manifest\+json)|image\/svg)/;

// ------------------------------------------------------------- routing

// `:name` becomes a capture. Everything else is literal, including the dot in
// `/playlist/:token.m3u` — the capture is lazy, so it stops at the extension
// rather than swallowing it.
function compile(pattern) {
  const names = [];
  const source = pattern
    .replace(/[.+*?^${}()|[\]\\]/g, '\\$&')
    .replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_, name) => {
      names.push(name);
      return '([^/]+?)';
    });
  return { regexp: new RegExp(`^${source}/?$`), names };
}

export function createApp() {
  const stack = [];
  const settings = new Map();

  const add = (method, pattern, handlers) => {
    const { regexp, names } = compile(pattern);
    stack.push({ method, regexp, names, handlers });
  };

  const app = {
    set: (key, value) => settings.set(key, value),
    get(pattern, ...handlers) {
      // Express overloads `get` as both a route and a settings reader.
      if (typeof pattern === 'string' && handlers.length === 0) return settings.get(pattern);
      add('GET', pattern, handlers);
      return app;
    },
    post(pattern, ...handlers) {
      add('POST', pattern, handlers);
      return app;
    },
    delete(pattern, ...handlers) {
      add('DELETE', pattern, handlers);
      return app;
    },
    use(handler) {
      // Four arguments means error middleware, as in Express.
      stack.push({ error: handler.length >= 4, handlers: [handler] });
      return app;
    },
    listen(port, host, callback) {
      const server = http.createServer((req, res) => {
        handle(stack, settings, req, res).catch((err) => {
          // Nothing left to try: the error middleware itself failed.
          console.error(err);
          if (!res.headersSent) res.writeHead(500);
          res.end();
        });
      });
      // A stalled upstream shouldn't hold a socket open indefinitely, but a
      // long film being proxied is not stalled — so only the headers are
      // given a deadline, not the body.
      server.headersTimeout = 30_000;
      server.requestTimeout = 0;
      return server.listen(port, host, callback);
    },
  };

  return app;
}

async function handle(stack, settings, req, res) {
  decorate(req, res, settings);

  let error = null;

  for (const layer of stack) {
    if (layer.error && !error) continue;
    if (!layer.error && error) continue;

    if (layer.regexp) {
      if (layer.method !== req.method && !(layer.method === 'GET' && req.method === 'HEAD')) continue;
      const match = layer.regexp.exec(req.pathname);
      if (!match) continue;
      req.params = Object.fromEntries(
        layer.names.map((name, i) => [name, safeDecode(match[i + 1])]),
      );
    }

    for (const handler of layer.handlers) {
      try {
        const passed = await runHandler(handler, req, res, error);
        if (res.writableEnded || res.headersSent) return;
        if (!passed) return;
        if (passed instanceof Error) { error = passed; break; }
        if (error && passed === true) error = null;
      } catch (err) {
        error = err;
        break;
      }
    }
  }

  if (res.writableEnded || res.headersSent) return;
  if (error) {
    console.error(error);
    res.status(500).json({ error: 'Something went wrong.' });
    return;
  }
  res.status(404).type('text/plain').send('Not found');
}

// A handler ends its turn in one of three ways, and all three have to be
// waited for: it calls next(), it answers the request, or it throws.
//
// The subtlety is that next() is often called later — a body parser calls it
// from a stream's 'end' event, long after the function itself has returned.
// Resolving on return would send a 404 out from under it, so the only honest
// signals are next() firing and the response actually finishing.
function runHandler(handler, req, res, error) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      res.off('finish', answered);
      res.off('close', answered);
      resolve(value);
    };
    // The response went out, so this handler dealt with it.
    const answered = () => finish(false);
    const next = (err) => {
      if (err) finish(err instanceof Error ? err : new Error(String(err)));
      else finish(true);
    };

    res.once('finish', answered);
    res.once('close', answered);

    let result;
    try {
      result = error ? handler(error, req, res, next) : handler(req, res, next);
    } catch (err) {
      settled = true;
      return reject(err);
    }

    if (result && typeof result.then === 'function') {
      result.then(() => finish(false), (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      });
    }
    return undefined;
  });
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// ------------------------------------------------- request and response

function decorate(req, res, settings) {
  const trustProxy = settings.get('trust proxy') === true;
  const url = new URL(req.url, 'http://placeholder');

  req.pathname = safeDecode(url.pathname);
  req.originalUrl = req.url;
  req.query = Object.fromEntries(url.searchParams);
  req.params = {};
  req.cookies = parseCookies(req.headers.cookie);
  req.get = (name) => req.headers[String(name).toLowerCase()];

  const forwardedProto = trustProxy && req.headers['x-forwarded-proto'];
  req.protocol = String(forwardedProto || '').split(',')[0].trim()
    || (req.socket.encrypted ? 'https' : 'http');
  req.secure = req.protocol === 'https';

  const forwardedFor = trustProxy && req.headers['x-forwarded-for'];
  req.ip = String(forwardedFor || '').split(',')[0].trim() || req.socket.remoteAddress;

  res.statusCode = 200;
  res.status = (code) => { res.statusCode = code; return res; };
  res.type = (value) => {
    res.setHeader('content-type', value.includes('/') ? value : (MIME[`.${value}`] || value));
    return res;
  };
  res.json = (value) => {
    if (!res.getHeader('content-type')) res.type('application/json; charset=utf-8');
    return res.send(JSON.stringify(value));
  };
  res.redirect = (code, location) => {
    const [status, target] = typeof code === 'number' ? [code, location] : [302, code];
    res.statusCode = status;
    res.setHeader('location', target);
    res.end();
  };
  res.send = (body) => sendBody(req, res, body);
  res.sendFile = (filePath) => sendFile(req, res, filePath, {});
  res.cookie = (name, value, options = {}) => {
    res.appendHeader('set-cookie', serializeCookie(name, value, options));
    return res;
  };
  res.clearCookie = (name, options = {}) => res.cookie(name, '', { ...options, maxAge: 0 });
}

function parseCookies(header) {
  const out = {};
  for (const pair of String(header || '').split(';')) {
    const index = pair.indexOf('=');
    if (index < 1) continue;
    out[pair.slice(0, index).trim()] = safeDecode(pair.slice(index + 1).trim());
  }
  return out;
}

function serializeCookie(name, value, options) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${options.path || '/'}`];
  if (options.httpOnly) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  if (options.sameSite) {
    const v = options.sameSite;
    parts.push(`SameSite=${v === true ? 'Strict' : v.charAt(0).toUpperCase() + v.slice(1)}`);
  }
  if (options.maxAge != null) {
    const seconds = Math.floor(options.maxAge / 1000);
    parts.push(`Max-Age=${seconds}`);
    parts.push(`Expires=${new Date(Date.now() + options.maxAge).toUTCString()}`);
  }
  return parts.join('; ');
}

// Text responses are gzipped above a kilobyte. A home screen is a couple of
// hundred kilobytes of JSON, most of it repeated field names and URLs from the
// same few hosts, so it compresses to a fraction — which is the difference
// between snappy and sluggish over a phone connection or a VPN.
async function sendBody(req, res, body) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''), 'utf8');
  const type = String(res.getHeader('content-type') || '');

  if (!type) res.type('text/html; charset=utf-8');

  if (req.method === 'HEAD') {
    res.setHeader('content-length', buffer.length);
    return res.end();
  }

  const wants = String(req.headers['accept-encoding'] || '').includes('gzip');
  if (wants && buffer.length >= COMPRESS_MIN && COMPRESSIBLE.test(type)) {
    try {
      const packed = await gzip(buffer);
      res.setHeader('content-encoding', 'gzip');
      res.setHeader('vary', 'accept-encoding');
      res.setHeader('content-length', packed.length);
      return res.end(packed);
    } catch {
      // Fall through and send it uncompressed.
    }
  }

  res.setHeader('content-length', buffer.length);
  return res.end(buffer);
}

// ---------------------------------------------------------------- static

export function staticFiles(root, { setHeaders } = {}) {
  return async function serve(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();

    const relative = req.pathname === '/' ? 'index.html' : req.pathname.replace(/^\/+/, '');
    const target = path.join(root, relative);

    // path.join resolves ".." — without this check, /../../etc/passwd works.
    if (!target.startsWith(path.resolve(root))) return next();

    try {
      const stats = await fsp.stat(target);
      if (stats.isDirectory()) return next();
      return await sendFile(req, res, target, { stats, setHeaders });
    } catch {
      return next();
    }
  };
}

async function sendFile(req, res, filePath, { stats, setHeaders }) {
  const info = stats || await fsp.stat(filePath);
  const etag = `W/"${info.size.toString(16)}-${info.mtimeMs.toString(16)}"`;

  res.type(MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream');
  res.setHeader('etag', etag);
  res.setHeader('last-modified', info.mtime.toUTCString());
  if (setHeaders) setHeaders(res, filePath);

  // A conditional request that still matches costs one header and no body.
  if (req.headers['if-none-match'] === etag) {
    res.statusCode = 304;
    return res.end();
  }

  // Small files are read into memory so they can be gzipped; anything large
  // is an image or a video and is streamed as-is.
  if (info.size <= 512 * 1024) {
    return res.send(await fsp.readFile(filePath));
  }

  res.setHeader('content-length', info.size);
  if (req.method === 'HEAD') return res.end();

  const stream = fs.createReadStream(filePath);
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  return stream.pipe(res);
}

// ------------------------------------------------------------ body parsing

export function jsonBody({ limit = BODY_LIMIT } = {}) {
  return function parse(req, res, next) {
    if (req.method !== 'POST' && req.method !== 'PUT' && req.method !== 'PATCH') {
      req.body = {};
      return next();
    }
    if (!String(req.headers['content-type'] || '').includes('application/json')) {
      req.body = {};
      return next();
    }

    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        res.status(413).json({ error: 'That request was too large.' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (res.writableEnded) return;
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        req.body = raw ? JSON.parse(raw) : {};
      } catch {
        req.body = {};
      }
      next();
    });
    req.on('error', () => next());
    return undefined;
  };
}
