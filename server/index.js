'use strict';

// nightTab sync server: serves the built web app and keeps the one shared
// profile (settings, groups, bookmarks, themes) as a JSON file on disk.
// No dependencies beyond the Node standard library.

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT, 10) || 8080;
const DATA_DIR = process.env.DATA_DIR || '/data';
const WEB_DIR = process.env.WEB_DIR || path.join(__dirname, '..', 'dist', 'web');
const MAX_BODY = (parseInt(process.env.MAX_BODY_MB, 10) || 10) * 1024 * 1024;
const BACKUP_KEEP = parseInt(process.env.BACKUP_KEEP, 10) || 30;

const DATA_FILE = path.join(DATA_DIR, 'nighttab.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf'
};

const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.svg']);

const log = (...args) => { console.log(new Date().toISOString(), ...args); };

// ---------------------------------------------------------------- storage

fs.mkdirSync(BACKUP_DIR, { recursive: true });

const revOf = (text) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);

// the stored profile, kept in memory; rev is '' while nothing is stored
const store = { text: null, rev: '' };

if (fs.existsSync(DATA_FILE)) {
  store.text = fs.readFileSync(DATA_FILE, 'utf8');
  store.rev = revOf(store.text);
  log('loaded profile, rev', store.rev, `(${store.text.length} bytes)`);
} else {
  log('no profile stored yet, waiting for the first device to upload one');
}

const backup = () => {
  if (store.text === null) { return; }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  fs.writeFileSync(path.join(BACKUP_DIR, `nighttab-${stamp}-${store.rev}.json`), store.text);

  const old = fs.readdirSync(BACKUP_DIR).filter((name) => name.endsWith('.json')).sort();

  old.slice(0, Math.max(0, old.length - BACKUP_KEEP)).forEach((name) => {
    fs.unlinkSync(path.join(BACKUP_DIR, name));
  });
};

const save = (text) => {
  const rev = revOf(text);

  if (rev === store.rev) { return rev; }

  backup();

  // write to a temp file first so a crash never leaves a half written profile
  const temp = DATA_FILE + '.tmp';

  fs.writeFileSync(temp, text);
  fs.renameSync(temp, DATA_FILE);

  store.text = text;
  store.rev = rev;

  return rev;
};

const wipe = () => {
  if (store.text === null) { return; }

  backup();

  fs.unlinkSync(DATA_FILE);

  store.text = null;
  store.rev = '';
};

// ----------------------------------------------------------------- events

const clients = new Set();

const broadcast = () => {
  clients.forEach((res) => { res.write(`event: rev\ndata: ${store.rev}\n\n`); });
};

setInterval(() => {
  clients.forEach((res) => { res.write(': ping\n\n'); });
}, 25000).unref();

// ------------------------------------------------------------------- http

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
};

const sendJson = (res, status, object) => {
  send(res, status, JSON.stringify(object), { 'Content-Type': MIME['.json'] });
};

const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;

  req.on('data', (chunk) => {
    size += chunk.length;

    if (size > MAX_BODY) {
      reject(Object.assign(new Error('payload too large'), { status: 413 }));
      req.destroy();
      return;
    }

    chunks.push(chunk);
  });

  req.on('end', () => { resolve(Buffer.concat(chunks).toString('utf8')); });
  req.on('error', reject);
});

const api = async (req, res, route) => {
  if (route === '/api/data') {
    switch (req.method) {
      case 'GET':
      case 'HEAD':
        if (store.text === null) { return send(res, 204); }

        return send(res, 200, req.method === 'HEAD' ? undefined : store.text, {
          'Content-Type': MIME['.json'],
          'X-NightTab-Rev': store.rev
        });

      case 'PUT': {
        const text = await readBody(req);

        let parsed;

        try { parsed = JSON.parse(text); } catch { parsed = null; }

        if (!parsed || parsed.nightTab !== true || typeof parsed.state !== 'object' || !Array.isArray(parsed.bookmark)) {
          return sendJson(res, 400, { error: 'not a nightTab profile' });
        }

        const before = store.rev;
        const rev = save(text);

        if (rev !== before) {
          log('profile saved, rev', rev, `(${text.length} bytes)`);
          broadcast();
        }

        return sendJson(res, 200, { rev });
      }

      case 'DELETE':
        if (store.text !== null) {
          wipe();
          log('profile wiped');
          broadcast();
        }

        return sendJson(res, 200, { rev: store.rev });

      default:
        return send(res, 405, undefined, { Allow: 'GET, HEAD, PUT, DELETE' });
    }
  }

  if (route === '/api/events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive'
    });

    res.write(`retry: 3000\nevent: rev\ndata: ${store.rev}\n\n`);

    clients.add(res);

    req.on('close', () => { clients.delete(res); });

    return;
  }

  if (route === '/api/health') {
    return sendJson(res, 200, { ok: true, rev: store.rev });
  }

  return sendJson(res, 404, { error: 'not found' });
};

// gzip once per file and keep the result, the web app is a handful of files
const gzipCache = new Map();

const serveStatic = (req, res, route) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, undefined, { Allow: 'GET, HEAD' });
  }

  let relative;

  try { relative = decodeURIComponent(route); } catch { return send(res, 400); }

  if (relative.endsWith('/')) { relative += 'index.html'; }

  const file = path.join(WEB_DIR, relative);

  if (file !== WEB_DIR && !file.startsWith(WEB_DIR + path.sep)) { return send(res, 403); }

  fs.stat(file, (error, stat) => {
    if (error || !stat.isFile()) { return send(res, 404, 'Not Found'); }

    const ext = path.extname(file).toLowerCase();

    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      // webpack puts a content hash into the bundle names, everything else must revalidate
      'Cache-Control': /\.[0-9a-f]{16,}\.(js|css)$/.test(file) ? 'public, max-age=31536000, immutable' : 'no-cache',
      'Last-Modified': stat.mtime.toUTCString()
    };

    if (req.headers['if-modified-since'] && new Date(req.headers['if-modified-since']) >= new Date(stat.mtime.toUTCString())) {
      res.writeHead(304, headers);
      return res.end();
    }

    const gzip = COMPRESSIBLE.has(ext) && /\bgzip\b/.test(req.headers['accept-encoding'] || '');

    if (gzip) {
      const key = file + ':' + stat.mtimeMs;

      if (!gzipCache.has(key)) { gzipCache.set(key, zlib.gzipSync(fs.readFileSync(file))); }

      const body = gzipCache.get(key);

      res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip', 'Content-Length': body.length, Vary: 'Accept-Encoding' });

      return res.end(req.method === 'HEAD' ? undefined : body);
    }

    res.writeHead(200, { ...headers, 'Content-Length': stat.size });

    if (req.method === 'HEAD') { return res.end(); }

    fs.createReadStream(file).pipe(res);
  });
};

const server = http.createServer((req, res) => {
  const route = req.url.split('?')[0];

  if (route.startsWith('/api/')) {
    api(req, res, route).catch((error) => {
      log('error', req.method, route, error.message);

      if (!res.headersSent) { sendJson(res, error.status || 500, { error: error.message }); }
    });
  } else {
    serveStatic(req, res, route);
  }
});

server.listen(PORT, () => { log(`nightTab listening on :${PORT}, data in ${DATA_DIR}`); });

['SIGINT', 'SIGTERM'].forEach((signal) => {
  process.on(signal, () => {
    clients.forEach((res) => { res.end(); });
    server.close(() => { process.exit(0); });
    setTimeout(() => { process.exit(0); }, 2000).unref();
  });
});
