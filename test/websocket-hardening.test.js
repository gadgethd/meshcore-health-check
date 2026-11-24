import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import WebSocket from 'ws';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.resolve(TEST_DIR, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-health-ws-test-'));
const observerFile = path.join(tempDir, 'observer.json');
const observerActivityFile = path.join(tempDir, 'observer-activity.json');
const resultsFile = path.join(tempDir, 'session-results.json');
fs.writeFileSync(observerFile, '{}\n', 'utf8');
fs.writeFileSync(observerActivityFile, '{"version":1,"observers":{}}\n', 'utf8');
fs.writeFileSync(resultsFile, '{"version":1,"sessions":[]}\n', 'utf8');

process.env.MESH_HEALTH_DISABLE_RUNTIME = 'true';
process.env.TURNSTILE_ENABLED = 'false';
process.env.TRUST_PROXY = '1';
process.env.OBSERVERS_FILE = observerFile;
process.env.OBSERVER_ACTIVITY_FILE = observerActivityFile;
process.env.RESULTS_FILE = resultsFile;
process.env.WS_ALLOWED_ORIGINS = 'https://allowed.example';
process.env.WS_ALLOW_MISSING_ORIGIN = 'true';
process.env.MAX_WS_CONNECTIONS = '8';
process.env.MAX_WS_CONNECTIONS_PER_IP = '3';
process.env.MAX_WS_MESSAGE_BYTES = '128';
process.env.WS_CONNECTION_RATE_MAX = '10';
process.env.WS_MESSAGE_RATE_MAX = '2';

const { flushScheduledWrites, server } = await import(
  `${pathToFileURL(path.join(REPO_DIR, 'server.js')).href}?ws-test=${Date.now()}`
);

let wsUrl = '';

function openSocket(options = {}, url = wsUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, options);
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

function rejectedStatus(options = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl, options);
    socket.once('unexpected-response', (_request, response) => {
      response.resume();
      resolve(response.statusCode);
    });
    socket.once('open', () => {
      socket.close();
      reject(new Error('WebSocket unexpectedly opened'));
    });
    socket.on('error', () => {});
  });
}

function closeSocket(socket) {
  if (socket.readyState === WebSocket.CLOSED) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    socket.once('close', resolve);
    socket.close();
  });
}

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  wsUrl = `ws://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await flushScheduledWrites();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('headerless legacy WebSocket clients connect while disallowed browser origins are rejected', async () => {
  const legacySocket = await openSocket(
    {},
    `${wsUrl}/legacy-observer?station=existing-config`,
  );
  await closeSocket(legacySocket);

  const allowedSocket = await openSocket({ origin: 'https://allowed.example' });
  await closeSocket(allowedSocket);

  assert.equal(
    await rejectedStatus({ origin: 'https://disallowed.example' }),
    403,
  );
});

test('per-IP connection cap rejects only the excess socket', async () => {
  const sockets = await Promise.all([openSocket(), openSocket(), openSocket()]);
  assert.equal(await rejectedStatus(), 503);
  assert.equal(sockets.every((socket) => socket.readyState === WebSocket.OPEN), true);
  const otherIpSocket = await openSocket({
    headers: { 'x-forwarded-for': '203.0.113.7' },
  });
  await Promise.all([...sockets, otherIpSocket].map(closeSocket));
});

test('global connection cap accounts for simultaneous upgrades without disturbing active clients', async () => {
  const sockets = await Promise.all(
    Array.from({ length: 8 }, (_value, index) => openSocket({
      headers: { 'x-forwarded-for': `203.0.113.${index + 1}` },
    })),
  );
  assert.equal(
    await rejectedStatus({ headers: { 'x-forwarded-for': '203.0.113.99' } }),
    503,
  );
  assert.equal(sockets.every((socket) => socket.readyState === WebSocket.OPEN), true);
  await Promise.all(sockets.map(closeSocket));
});

test('inbound frames cannot mutate observer state and message limits isolate the sender', async () => {
  const bootstrapUrl = wsUrl.replace(/^ws:/, 'http:') + '/api/bootstrap';
  const beforeSnapshot = await (await fetch(bootstrapUrl)).json();
  const socket = await openSocket();
  socket.send('{"type":"observer-update"}');
  socket.send('{"type":"session-update"}');
  const closeCode = await new Promise((resolve) => {
    socket.once('close', resolve);
    socket.send('{"type":"third-message"}');
  });
  assert.equal(closeCode, 1008);
  const afterSnapshot = await (await fetch(bootstrapUrl)).json();
  assert.equal(afterSnapshot.observerStats.activeCount, beforeSnapshot.observerStats.activeCount);

  const oversizedSocket = await openSocket();
  const oversizedCloseCode = await new Promise((resolve) => {
    oversizedSocket.once('close', resolve);
    oversizedSocket.send(Buffer.alloc(129));
  });
  assert.equal(oversizedCloseCode, 1009);
});

test('connection-attempt rate limiting rejects only the excess IP', async () => {
  const limitedOptions = {
    headers: { 'x-forwarded-for': '198.51.100.25' },
  };
  for (let index = 0; index < 10; index += 1) {
    const socket = await openSocket(limitedOptions);
    await closeSocket(socket);
  }
  assert.equal(await rejectedStatus(limitedOptions), 429);

  const unaffectedSocket = await openSocket({
    headers: { 'x-forwarded-for': '198.51.100.26' },
  });
  await closeSocket(unaffectedSocket);
});
