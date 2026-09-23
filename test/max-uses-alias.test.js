import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildGroupTextEnvelope } from './support/build-meshcore-fixture.js';

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-health-alias-test-'));
const observerFile = path.join(tempDir, 'observer.json');
const observerActivityFile = path.join(tempDir, 'observer-activity.json');
const resultsFile = path.join(tempDir, 'session-results.json');
fs.writeFileSync(observerFile, '{}\n', 'utf8');
fs.writeFileSync(observerActivityFile, '{\n  "version": 1,\n  "observers": {}\n}\n', 'utf8');
fs.writeFileSync(resultsFile, '{\n  "version": 1,\n  "sessions": []\n}\n', 'utf8');

process.env.MESH_HEALTH_DISABLE_RUNTIME = 'true';
process.env.TURNSTILE_ENABLED = 'false';
process.env.TEST_CHANNEL_NAME = 'health-check';
process.env.TEST_CHANNEL_SECRET = 'E6D973AAC5101145AD3A3F3A0B3D52EB';
process.env.MAX_USES_PER_CODE = '1';
process.env.OBSERVERS_FILE = observerFile;
process.env.OBSERVER_ACTIVITY_FILE = observerActivityFile;
process.env.RESULTS_FILE = resultsFile;
process.env.OBSERVER_RETENTION_SECONDS = '14400';

const serverModule = await import(
  `${pathToFileURL(path.join(REPO_DIR, 'server.js')).href}?max-uses-alias=${Date.now()}`
);
const { flushScheduledWrites, ingestMqttMessage, resetTestState, server } = serverModule;
const firstObserverKey = 'AF07FC2005E04D08DDA921E64985E62201BF974AE0B0E35084B804229ED11A2B';
const secondObserverKey = 'C689DF3FEB9A7A5EF05E9642C75ABB8C10DF13D974F196027AA7945BEA996FA4';

let baseUrl = '';

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
  resetTestState();
});

after(async () => {
  flushScheduledWrites();
  if (server.listening) {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function exerciseAliasOrder(firstKey, secondKey) {
  const createResponse = await fetch(`${baseUrl}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(createResponse.status, 201);
  const created = await createResponse.json();
  const message = `single use alias ${created.code}`;
  const firstEnvelope = buildGroupTextEnvelope({
    secretHex: process.env.TEST_CHANNEL_SECRET,
    sender: 'Alias Tester',
    message,
    messageHash: '1111111111111111',
    timestamp: 1762000000,
    path: ['11'],
  });
  const secondEnvelope = buildGroupTextEnvelope({
    secretHex: process.env.TEST_CHANNEL_SECRET,
    sender: 'Alias Tester',
    message,
    messageHash: '2222222222222222',
    timestamp: 1762000000,
    path: ['22'],
  });

  ingestMqttMessage(
    `meshcore/BOS/${firstKey}/packets`,
    Buffer.from(JSON.stringify(firstKey === firstObserverKey ? firstEnvelope : secondEnvelope)),
  );
  ingestMqttMessage(
    `meshcore/BOS/${secondKey}/packets`,
    Buffer.from(JSON.stringify(secondKey === secondObserverKey ? secondEnvelope : firstEnvelope)),
  );

  const sessionResponse = await fetch(`${baseUrl}/api/sessions/${created.id}`);
  assert.equal(sessionResponse.status, 200);
  const session = await sessionResponse.json();
  assert.equal(session.useCount, 1);
  assert.equal(session.status, 'exhausted');
  assert.equal(session.observedCount, 2);
  assert.equal(session.receipts.length, 2);
  assert.equal(session.messageHash, firstKey === firstObserverKey ? firstEnvelope.hash : secondEnvelope.hash);
}

test('final allowed use accepts a later canonical hash alias', async () => {
  await exerciseAliasOrder(firstObserverKey, secondObserverKey);
});

test('final allowed use accepts the canonical hash alias in either arrival order', async () => {
  await exerciseAliasOrder(secondObserverKey, firstObserverKey);
});
