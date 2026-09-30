import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { deflateSync } from 'node:zlib';
import express from 'express';
import { createTileRouter } from '../lib/tile-proxy.js';

function pngChunk(type, data) {
  const payload = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const byte of payload) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length);
  payload.copy(result, 4);
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
  return result;
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(256, 0);
ihdr.writeUInt32BE(256, 4);
ihdr[8] = 8;
ihdr[9] = 2;
const png = Buffer.concat([
  Buffer.from('89504e470d0a1a0a', 'hex'),
  pngChunk('IHDR', ihdr),
  pngChunk('IDAT', deflateSync(Buffer.alloc(256 * (256 * 3 + 1)))),
  pngChunk('IEND', Buffer.alloc(0)),
]);

function tileResponse(headers = {}) {
  return new Response(png, { headers: { 'content-type': 'image/png', ...headers } });
}

async function fixture(t, options) {
  const app = express();
  app.use('/tiles', createTileRouter(options));
  app.get(/.*/, (request, response) => response.type('html').send('App shell'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.on('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}/tiles`;
}

test('tiles use an identified fixed upstream and share the HTTP cache across clients', async (t) => {
  const calls = [];
  const base = await fixture(t, {
    siteUrl: 'https://healthcheck.example.test/app',
    userAgent: 'MeshHealthCheck/test (+https://healthcheck.example.test)',
    fetchTile: async (url, options) => {
      calls.push({ url, options });
      return tileResponse({ 'cache-control': 'public, max-age=3600', etag: '"tile-1"' });
    },
  });
  const first = await fetch(`${base}/osm/10/511/340.png`, {
    headers: { cookie: 'test=value', authorization: 'test-value', 'cache-control': 'no-cache' },
  });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('content-type'), 'image/png');
  assert.equal(first.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.deepEqual(Buffer.from(await first.arrayBuffer()), png);
  assert.equal(calls[0].url, 'https://tile.openstreetmap.org/10/511/340.png');
  assert.deepEqual(calls[0].options.headers, {
    'User-Agent': 'MeshHealthCheck/test (+https://healthcheck.example.test)',
    Referer: 'https://healthcheck.example.test/',
    Accept: 'image/png',
  });
  assert.equal(calls[0].options.redirect, 'error');
  const head = await fetch(`${base}/osm/10/511/340.png`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(png.length));
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  const conditional = await fetch(`${base}/osm/10/511/340.png`, {
    headers: { 'if-none-match': '"tile-1"', 'cache-control': 'max-age=0' },
  });
  assert.equal(conditional.status, 304);
  assert.equal(calls.length, 1);
});

test('tile paths, methods and cross-site requests cannot fetch arbitrary resources', async (t) => {
  let count = 0;
  const base = await fixture(t, { fetchTile: async () => { count += 1; return tileResponse(); } });
  for (const path of [
    '/osm/20/0/0.png', '/osm/0/1/0.png', '/osm/1/0/2.png', '/osm/-1/0/0.png',
    '/osm/01/0/0.png', '/osm/1/00/0.png', '/osm/1/0/0@2x.png', '/osm/1/0/0.png?url=https://example.test',
    '/https://example.test/1/0/0.png', '/osm/1/0/0.jpg', '/anything', '',
  ]) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 404, path);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(await response.text(), '');
  }
  const post = await fetch(`${base}/osm/0/0/0.png`, { method: 'POST' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET, HEAD');
  const crossSite = await fetch(`${base}/osm/0/0/0.png`, { headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(crossSite.status, 403);
  assert.equal(count, 0);
});

test('expired tiles revalidate with upstream validators and reuse the image on 304', async (t) => {
  let clock = Date.parse('2026-09-08T00:00:00Z');
  const calls = [];
  const base = await fixture(t, {
    now: () => clock,
    fetchTile: async (url, options) => {
      calls.push(options.headers);
      const headers = { 'cache-control': 'max-age=60', age: '30', date: new Date(clock).toUTCString() };
      return calls.length === 1
        ? tileResponse({ ...headers, etag: '"old"', 'last-modified': 'Mon, 07 Sep 2026 00:00:00 GMT' })
        : new Response(null, { status: 304, headers: { ...headers, age: '0' } });
    },
  });
  await fetch(`${base}/osm/1/0/0.png`);
  clock += 20000;
  const cached = await fetch(`${base}/osm/1/0/0.png`);
  assert.equal(cached.headers.get('age'), '50');
  assert.equal(calls.length, 1);
  clock += 11000;
  const revalidated = await fetch(`${base}/osm/1/0/0.png`);
  assert.equal(revalidated.status, 200);
  assert.equal(revalidated.headers.get('etag'), '"old"');
  assert.deepEqual(Buffer.from(await revalidated.arrayBuffer()), png);
  assert.equal(calls.length, 2);
  assert.equal(calls[1]['If-None-Match'], '"old"');
  assert.equal(calls[1]['If-Modified-Since'], 'Mon, 07 Sep 2026 00:00:00 GMT');
  await fetch(`${base}/osm/1/0/0.png`);
  assert.equal(calls.length, 2);
});

test('cache honors Expires, missing expiry, no-store, private and no-cache', async (t) => {
  for (const [headers, expectedCalls, expectedCacheControl] of [
    [{}, 1, 'public, max-age=604800'],
    [{ expires: 'Tue, 08 Sep 2026 00:01:00 GMT' }, 1, 'public, max-age=60'],
    [{ 'cache-control': 'no-store' }, 2, 'no-store'],
    [{ 'cache-control': 'private, max-age=3600' }, 2, 'private, max-age=3600'],
    [{ 'cache-control': 'no-cache, max-age=3600' }, 2, 'no-cache, max-age=3600'],
  ]) {
    let calls = 0;
    const base = await fixture(t, {
      now: () => Date.parse('2026-09-08T00:00:00Z'),
      fetchTile: async () => { calls += 1; return tileResponse(headers); },
    });
    await fetch(`${base}/osm/1/0/0.png`);
    const response = await fetch(`${base}/osm/1/0/0.png`);
    assert.equal(calls, expectedCalls);
    assert.equal(response.headers.get('cache-control'), expectedCacheControl);
  }
});

test('a replacement 200 response does not inherit the previous image validators', async (t) => {
  let calls = 0;
  const base = await fixture(t, {
    fetchTile: async () => {
      calls += 1;
      return tileResponse(calls === 1 ? { etag: '"old"', 'cache-control': 'no-cache' } : {});
    },
  });
  await fetch(`${base}/osm/1/0/0.png`);
  const response = await fetch(`${base}/osm/1/0/0.png`);
  assert.notEqual(response.headers.get('etag'), '"old"');
  assert.equal(response.headers.get('cache-control'), 'public, max-age=604800');
});

test('tile failures are uncached, generic and never relayed as successful images', async (t) => {
  const blockedTile = fs.readFileSync(new URL('./fixtures/osm-blocked-tile.png', import.meta.url));
  for (const upstream of [
    () => new Response('provider failure', { status: 403 }),
    () => new Response('provider failure', { status: 429 }),
    () => new Response('<html>provider failure</html>', { headers: { 'content-type': 'text/html' } }),
    () => new Response('not a PNG', { headers: { 'content-type': 'image/png' } }),
    () => new Response(blockedTile, { headers: { 'content-type': 'image/png' } }),
    () => tileResponse({ 'content-length': '9999999' }),
    () => new Response(Buffer.alloc(513 * 1024), { headers: { 'content-type': 'image/png' } }),
    () => { throw new Error('upstream error with private details'); },
  ]) {
    let calls = 0;
    const base = await fixture(t, { fetchTile: async () => { calls += 1; return upstream(); } });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await fetch(`${base}/osm/1/0/0.png`);
      assert.equal(response.status, 502);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await response.json(), { error: 'map_tiles_unavailable' });
    }
    assert.equal(calls, 2);
  }
});

test('upstream requests time out without leaving a pending tile behind', async (t) => {
  let calls = 0;
  const base = await fixture(t, {
    timeoutMs: 20,
    fetchTile: async (url, options) => {
      calls += 1;
      await new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason)));
    },
  });
  assert.equal((await fetch(`${base}/osm/1/0/0.png`)).status, 502);
  assert.equal((await fetch(`${base}/osm/1/0/0.png`)).status, 502);
  assert.equal(calls, 2);
});

test('bounded LRU cache evicts the least recently used image', async (t) => {
  const calls = [];
  const base = await fixture(t, {
    maximumCacheBytes: png.length * 2,
    fetchTile: async (url) => { calls.push(url); return tileResponse(); },
  });
  for (const x of [0, 1, 0, 2, 0, 1]) {
    assert.equal((await fetch(`${base}/osm/2/${x}/0.png`)).status, 200);
  }
  assert.equal(calls.length, 4);
});

test('concurrent tile requests are deduplicated and upstream concurrency is bounded', async (t) => {
  let unblock;
  let started;
  const firstStarted = new Promise((resolve) => { started = resolve; });
  const gate = new Promise((resolve) => { unblock = resolve; });
  let active = 0;
  let maximumActive = 0;
  let calls = 0;
  const base = await fixture(t, {
    maximumConcurrent: 1,
    maximumPending: 2,
    fetchTile: async () => {
      calls += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      started();
      await gate;
      active -= 1;
      return tileResponse();
    },
  });
  const first = fetch(`${base}/osm/2/0/0.png`);
  await firstStarted;
  const duplicate = fetch(`${base}/osm/2/0/0.png`);
  const queued = fetch(`${base}/osm/2/1/0.png`);
  const overflow = fetch(`${base}/osm/2/2/0.png`);
  t.after(() => unblock());
  const rejected = await overflow;
  assert.equal(rejected.status, 503);
  assert.equal(rejected.headers.get('retry-after'), '1');
  unblock();
  for (const response of await Promise.all([first, duplicate, queued])) {
    assert.equal(response.status, 200);
  }
  assert.equal(calls, 2);
  assert.equal(maximumActive, 1);
});
