#!/usr/bin/env node
/**
 * Local stand-in for the few Cloudinary endpoints used by the media module
 * (#131), to exercise the whole upload flow without a Cloudinary account:
 *
 *   POST /v1_1/:cloud/image/upload                      signed upload (multipart)
 *   GET  /v1_1/:cloud/resources/image/upload/:publicId  Admin API (basic auth)
 *   POST /v1_1/:cloud/image/destroy                     signed destroy
 *   GET  /:cloud/image/upload/.../v:version/:publicId.:ext  delivery (transformations ignored)
 *
 * Signatures are checked with the same algorithm as Cloudinary. Files live in
 * memory. Usage:
 *
 *   FAKE_CLOUDINARY_PORT=3229 FAKE_CLOUDINARY_KEY=123 FAKE_CLOUDINARY_SECRET=shh \
 *     node scripts/fake-cloudinary.js
 *   # then run the API with CLOUDINARY_API_BASE=http://localhost:3229 and the
 *   # same key / secret configured in /admin/integrations (any cloud name).
 */
const http = require('http');
const crypto = require('crypto');

const PORT = Number(process.env.FAKE_CLOUDINARY_PORT || 3229);
const API_KEY = process.env.FAKE_CLOUDINARY_KEY || '123';
const API_SECRET = process.env.FAKE_CLOUDINARY_SECRET || 'shh';
const BASE = `http://localhost:${PORT}`;

const store = new Map(); // publicId -> { buffer, format, width, height, pages, version }

function sign(params) {
  const excluded = new Set(['file', 'cloud_name', 'resource_type', 'api_key', 'signature']);
  const payload = Object.keys(params)
    .filter((k) => !excluded.has(k) && params[k] !== undefined && params[k] !== '')
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  return crypto.createHash('sha1').update(payload + API_SECRET).digest('hex');
}

/** Format, dimensions and frame count from the file header. */
function probe(buf) {
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { format: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), pages: 1 };
  }
  if (buf.slice(0, 3).toString('ascii') === 'GIF') {
    // Count image descriptors (0x2C after a block terminator) roughly.
    let frames = 0;
    for (let i = 13; i < buf.length; i++) if (buf[i] === 0x2c && buf[i - 1] === 0x00) frames++;
    return { format: 'gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8), pages: Math.max(frames, 1) };
  }
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') {
    const chunk = buf.slice(12, 16).toString('ascii');
    if (chunk === 'VP8X') return { format: 'webp', width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3), pages: 1 };
    if (chunk === 'VP8L') {
      const b = buf.readUInt32LE(21);
      return { format: 'webp', width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1, pages: 1 };
    }
    return { format: 'webp', width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff, pages: 1 };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length) {
      if (buf[i] !== 0xff) break;
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xc3) {
        return { format: 'jpg', height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7), pages: 1 };
      }
      i += 2 + len;
    }
    return { format: 'jpg', width: 0, height: 0, pages: 1 };
  }
  if (buf.slice(0, 200).toString('utf8').includes('<svg')) return { format: 'svg', width: 100, height: 100, pages: 1 };
  return null;
}

function resource(publicId) {
  const f = store.get(publicId);
  return {
    public_id: publicId,
    format: f.format,
    resource_type: 'image',
    type: 'upload',
    bytes: f.buffer.length,
    width: f.width,
    height: f.height,
    pages: f.pages,
    version: f.version,
    secure_url: `${BASE}/demo/image/upload/v${f.version}/${publicId}.${f.format}`,
  };
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    ...(Buffer.isBuffer(body) ? {} : { 'Content-Type': 'application/json' }),
    ...headers,
  });
  res.end(Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

const readBody = (req) =>
  new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, BASE);
    const path = decodeURIComponent(url.pathname);
    if (req.method === 'OPTIONS') return send(res, 204, {});
    try {
      if (req.method === 'POST' && /^\/v1_1\/[^/]+\/image\/upload$/.test(path)) {
        const body = await readBody(req);
        const form = await new Response(body, { headers: { 'content-type': req.headers['content-type'] } }).formData();
        const params = {};
        let file = null;
        for (const [k, v] of form.entries()) {
          if (k === 'file') file = Buffer.from(await v.arrayBuffer());
          else params[k] = v;
        }
        if (params.api_key !== API_KEY) return send(res, 401, { error: { message: 'Invalid api_key' } });
        if (params.signature !== sign(params)) return send(res, 401, { error: { message: 'Invalid Signature' } });
        if (Math.abs(Date.now() / 1000 - Number(params.timestamp)) > 3600) {
          return send(res, 400, { error: { message: 'Stale request' } });
        }
        const info = file && probe(file);
        if (!info) return send(res, 400, { error: { message: 'Invalid image file' } });
        const allowed = (params.allowed_formats || '').split(',').filter(Boolean);
        if (allowed.length && !allowed.includes(info.format)) {
          return send(res, 400, { error: { message: `Image format ${info.format} not allowed` } });
        }
        const publicId = params.public_id || crypto.randomBytes(8).toString('hex');
        // Like Cloudinary: overwrite=false keeps the existing asset untouched.
        if (params.overwrite === 'false' && store.has(publicId)) {
          return send(res, 200, { ...resource(publicId), existing: true });
        }
        store.set(publicId, { buffer: file, ...info, version: Math.floor(Date.now() / 1000) });
        console.log(`upload ${publicId} (${info.format} ${info.width}x${info.height}, ${file.length} B)`);
        return send(res, 200, resource(publicId));
      }
      const m = path.match(/^\/v1_1\/[^/]+\/resources\/image\/upload\/(.+)$/);
      if (req.method === 'GET' && m) {
        const auth = Buffer.from(`${API_KEY}:${API_SECRET}`).toString('base64');
        if (req.headers.authorization !== `Basic ${auth}`) return send(res, 401, { error: { message: 'Unauthorized' } });
        if (!store.has(m[1])) return send(res, 404, { error: { message: 'Resource not found' } });
        return send(res, 200, resource(m[1]));
      }
      if (req.method === 'POST' && /^\/v1_1\/[^/]+\/image\/destroy$/.test(path)) {
        const params = Object.fromEntries(new URLSearchParams((await readBody(req)).toString()));
        if (params.api_key !== API_KEY || params.signature !== sign(params)) {
          return send(res, 401, { error: { message: 'Invalid Signature' } });
        }
        const existed = store.delete(params.public_id);
        console.log(`destroy ${params.public_id} -> ${existed ? 'ok' : 'not found'}`);
        return send(res, 200, { result: existed ? 'ok' : 'not found' });
      }
      const d = path.match(/^\/[^/]+\/image\/upload\/(?:.*?\/)?v\d+\/(.+)\.[a-z]+$/);
      if (req.method === 'GET' && d && store.has(d[1])) {
        const f = store.get(d[1]);
        return send(res, 200, f.buffer, { 'Content-Type': `image/${f.format === 'jpg' ? 'jpeg' : f.format}` });
      }
      return send(res, 404, { error: { message: 'Not found' } });
    } catch (err) {
      return send(res, 500, { error: { message: err.message } });
    }
  })
  .listen(PORT, () => console.log(`Fake Cloudinary on ${BASE} (api_key=${API_KEY})`));
