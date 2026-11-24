import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildGroupTextEnvelope } from './support/build-meshcore-fixture.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.resolve(TEST_DIR, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-health-check-code-prefix-test-'));
const observerFile = path.join(tempDir, 'observer.json');
const observerActivityFile = path.join(tempDir, 'observer-activity.json');
const resultsFile = path.join(tempDir, 'session-results.json');
fs.writeFileSync(observerFile, '{}\n', 'utf8');
fs.writeFileSync(observerActivityFile, '{\n  "version": 1,\n  "observers": {}\n}\n', 'utf8');
fs.writeFileSync(resultsFile, '{\n  "version": 1,\n  "sessions": []\n}\n', 'utf8');

process.env.MESH_HEALTH_DISABLE_RUNTIME = 'true';
process.env.TURNSTILE_ENABLED = 'false';
process.env.LOG_LEVEL = 'info';
process.env.OBSERVERS_FILE = observerFile;
process.env.OBSERVER_ACTIVITY_FILE = observerActivityFile;
process.env.RESULTS_FILE = resultsFile;
process.env.TEST_CHANNEL_NAME = 'health-check';
process.env.TEST_CHANNEL_SECRET = 'E6D973AAC5101145AD3A3F3A0B3D52EB';
process.env.CODE_PREFIX = ' nyhc ';
process.env.ALLOW_LONGER_TEST_CODES = 'false';

const packetFixture = JSON.parse(
  fs.readFileSync(path.join(TEST_DIR, 'fixtures/grouptext-message.json'), 'utf8'),
);

const serverModule = await import(
  `${pathToFileURL(path.join(REPO_DIR, 'server.js')).href}?code-prefix-test=${Date.now()}`
);

const {
  flushScheduledWrites,
  ingestMqttMessage,
  resetTestState,
  server,
} = serverModule;

let baseUrl = '';

before(async () => {
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

beforeEach(() => {
  resetTestState();
});

after(async () => {
  await flushScheduledWrites();
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('CODE_PREFIX is normalized and used for generated codes', async () => {
  const createResponse = await fetch(`${baseUrl}/api/sessions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: '{}',
  });

  assert.equal(createResponse.status, 201);
  const created = await createResponse.json();
  assert.match(created.code, /^NYHC-[0-9A-F]{6}$/);
  assert.equal(created.instructions, `Send ${created.code} to #health-check`);
});

test('codes with a custom CODE_PREFIX match channel messages', async () => {
  const createResponse = await fetch(`${baseUrl}/api/sessions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: '{}',
  });
  const created = await createResponse.json();

  const wrongEnvelope = buildGroupTextEnvelope({
    secretHex: process.env.TEST_CHANNEL_SECRET, sender: packetFixture.sender,
    message: `X${created.code} ${created.code}0`,
    messageHash: '0123456789ABCDEF', timestamp: packetFixture.timestamp, path: packetFixture.path,
  });
  ingestMqttMessage(`meshcore/BOS/${packetFixture.observerKeys[0]}/packets`, Buffer.from(JSON.stringify(wrongEnvelope)));
  assert.equal((await (await fetch(`${baseUrl}/api/sessions/${created.id}`)).json()).observedCount, 0);

  const message = packetFixture.messageTemplate.replace('{code}', created.code);
  const envelope = buildGroupTextEnvelope({
    secretHex: process.env.TEST_CHANNEL_SECRET,
    sender: packetFixture.sender,
    message,
    messageHash: packetFixture.messageHash,
    timestamp: packetFixture.timestamp,
    path: packetFixture.path,
  });
  ingestMqttMessage(
    `meshcore/BOS/${packetFixture.observerKeys[0]}/packets`,
    Buffer.from(JSON.stringify(envelope)),
  );

  const sessionResponse = await fetch(`${baseUrl}/api/sessions/${created.id}`);
  const session = await sessionResponse.json();
  assert.equal(session.messageBody, message);
  assert.equal(session.observedCount, 1);
});


test('prefix normalization accepts only one to eight ASCII alphanumerics', async () => {
  for (const [value, expected] of [
    ['', 'MHC'], ['   ', 'MHC'], ['a', 'A'], ['12ab34cd', '12AB34CD'],
    [' nyhc ', 'NYHC'], ['ABCDEFGHI', 'MHC'], ['NY-HC', 'MHC'],
    ['NY_HC', 'MHC'], ['é', 'MHC'], ['你好', 'MHC'], ['A.B', 'MHC'],
    ['ß', 'MHC'], ['ı', 'MHC'], ['ſ', 'MHC'],
  ]) {
    process.env.CODE_PREFIX = value;
    const loaded = await import(`${pathToFileURL(path.join(REPO_DIR, 'server.js')).href}?prefix-edge=${encodeURIComponent(value)}`);
    await new Promise(resolve => loaded.server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${loaded.server.address().port}`;
    try {
      const bootstrap = await (await fetch(`${url}/api/bootstrap`)).json();
      assert.equal(bootstrap.codeOptions.prefix, expected, JSON.stringify(value));
      const created = await (await fetch(`${url}/api/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
      assert.match(created.code, new RegExp(`^${expected}-[0-9A-F]{6}$`));
    } finally {
      await new Promise(resolve => loaded.server.close(resolve));
    }
  }
});
