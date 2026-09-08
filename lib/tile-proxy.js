import { createHash } from 'node:crypto';
import express from 'express';

const TILE_ORIGIN = 'https://tile.openstreetmap.org';
const FALLBACK_MAX_AGE = 7 * 24 * 60 * 60;
const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');
// OSM can return its policy error image with HTTP 200, observed on 2026-09-08.
const OSM_BLOCKED_TILE_HASH = 'b02c44252dac5a5e820ecef1e9bf9200e9407c042df668a466a1aa81a9ecca7a';

function cacheMetadata(headers, previous, now) {
  const date = Date.parse(headers.get('date'));
  const expires = headers.get('expires') || '';
  const expiresAt = Date.parse(expires);
  const fallbackLifetime = Number.isFinite(expiresAt)
    ? Math.max(0, Math.floor((expiresAt - (Number.isFinite(date) ? date : now)) / 1000))
    : FALLBACK_MAX_AGE;
  const cacheControl = headers.get('cache-control')
    || previous?.cacheControl
    || `public, max-age=${fallbackLifetime}`;
  const directives = cacheControl.toLowerCase();
  const maxAge = directives.match(/(?:^|,)\s*s-maxage\s*=\s*"?(\d+)/)
    || directives.match(/(?:^|,)\s*max-age\s*=\s*"?(\d+)/);
  const age = Math.max(
    Number(headers.get('age')) || 0,
    Number.isFinite(date) ? Math.max(0, (now - date) / 1000) : 0,
  );
  const lifetime = maxAge ? Number(maxAge[1]) : fallbackLifetime;
  const mustValidate = /(?:^|,)\s*no-cache\b/.test(directives);
  return {
    cacheControl,
    expires,
    age,
    storedAt: now,
    freshUntil: now + (mustValidate ? 0 : Math.max(0, lifetime - age) * 1000),
    cacheable: !/(?:^|,)\s*(?:no-store|private)\b/.test(directives),
    etag: headers.get('etag') || previous?.etag || '',
    lastModified: headers.get('last-modified') || previous?.lastModified || '',
  };
}

async function readTile(upstream, maximumBytes) {
  if (
    upstream.status !== 200
    || upstream.headers.get('content-type')?.split(';')[0].trim() !== 'image/png'
    || Number(upstream.headers.get('content-length')) > maximumBytes
  ) {
    await upstream.body?.cancel();
    throw new Error('invalid_tile_response');
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of upstream.body) {
    bytes += chunk.length;
    if (bytes > maximumBytes) {
      throw new Error('tile_too_large');
    }
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);
  if (
    body.length < 45
    || !body.subarray(0, 8).equals(PNG_SIGNATURE)
    || body.toString('ascii', 12, 16) !== 'IHDR'
    || body.readUInt32BE(16) !== 256
    || body.readUInt32BE(20) !== 256
    || body.toString('ascii', body.length - 8, body.length - 4) !== 'IEND'
    || createHash('sha256').update(body).digest('hex') === OSM_BLOCKED_TILE_HASH
  ) {
    throw new Error('invalid_tile_image');
  }
  return body;
}

export function createTileRouter({
  siteUrl = '',
  userAgent = 'MeshHealthCheck (+https://github.com/yellowcooln/meshcore-health-check)',
  fetchTile = globalThis.fetch,
  now = Date.now,
  maximumCacheBytes = 64 * 1024 * 1024,
  maximumCacheEntries = 2048,
  maximumTileBytes = 512 * 1024,
  maximumConcurrent = 8,
  maximumPending = 64,
  timeoutMs = 10000,
} = {}) {
  const router = express.Router();
  const cache = new Map();
  const pending = new Map();
  const queue = [];
  let cacheBytes = 0;
  let active = 0;

  function forget(key) {
    cacheBytes -= cache.get(key)?.body.length || 0;
    cache.delete(key);
  }

  function remember(key, entry) {
    forget(key);
    if (!entry.cacheable || entry.body.length > maximumCacheBytes) {
      return;
    }
    while (cache.size >= maximumCacheEntries || cacheBytes + entry.body.length > maximumCacheBytes) {
      forget(cache.keys().next().value);
    }
    cache.set(key, entry);
    cacheBytes += entry.body.length;
  }

  async function download(key, previous, referer) {
    if (active >= maximumConcurrent) {
      await new Promise((resolve) => queue.push(resolve));
    } else {
      active += 1;
    }
    try {
      const headers = { 'User-Agent': userAgent, Referer: referer, Accept: 'image/png' };
      if (previous?.etag) {
        headers['If-None-Match'] = previous.etag;
      }
      if (previous?.lastModified) {
        headers['If-Modified-Since'] = previous.lastModified;
      }
      const upstream = await fetchTile(`${TILE_ORIGIN}/${key}.png`, {
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
      let body;
      if (upstream.status === 304 && previous) {
        await upstream.body?.cancel();
        body = previous.body;
      } else {
        body = await readTile(upstream, maximumTileBytes);
      }
      const entry = {
        body,
        ...cacheMetadata(upstream.headers, upstream.status === 304 ? previous : null, now()),
      };
      remember(key, entry);
      return entry;
    } finally {
      const next = queue.shift();
      if (next) {
        next();
      } else {
        active -= 1;
      }
    }
  }

  router.use(async (request, response) => {
    response.set('Cache-Control', 'no-store');
    response.set('Cross-Origin-Resource-Policy', 'same-origin');
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.set('Allow', 'GET, HEAD').status(405).end();
      return;
    }
    if (request.get('sec-fetch-site') === 'cross-site') {
      response.status(403).end();
      return;
    }
    const match = request.path.match(/^\/osm\/(0|[1-9]\d?)\/(0|[1-9]\d{0,5})\/(0|[1-9]\d{0,5})\.png$/);
    if (
      !match || request.url.includes('?') || Number(match[1]) > 19
      || Number(match[2]) >= 2 ** Number(match[1])
      || Number(match[3]) >= 2 ** Number(match[1])
    ) {
      response.status(404).end();
      return;
    }
    const key = match.slice(1).join('/');
    try {
      let entry = cache.get(key);
      if (entry && entry.freshUntil > now()) {
        cache.delete(key);
        cache.set(key, entry);
      } else {
        if (!pending.has(key)) {
          if (pending.size >= maximumPending) {
            response.set('Retry-After', '1').status(503).end();
            return;
          }
          const origin = new URL(siteUrl || `${request.protocol}://${request.get('host')}`).origin;
          const task = download(key, entry, `${origin}/`).finally(() => pending.delete(key));
          pending.set(key, task);
        }
        entry = await pending.get(key);
      }
      response.set('Cache-Control', entry.cacheControl);
      response.set('Age', String(Math.floor(entry.age + (now() - entry.storedAt) / 1000)));
      if (entry.etag) response.set('ETag', entry.etag);
      if (entry.lastModified) response.set('Last-Modified', entry.lastModified);
      if (entry.expires) response.set('Expires', entry.expires);
      response.type('png').send(entry.body);
    } catch {
      // Never relay upstream error bodies, request headers or credentials.
      response.set('Cache-Control', 'no-store').status(502).json({ error: 'map_tiles_unavailable' });
    }
  });
  return router;
}
