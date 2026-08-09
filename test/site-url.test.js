import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.resolve(TEST_DIR, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-health-check-site-url-test-'));
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
process.env.SITE_URL = 'https://mesh.example.org/check/';

const serverModule = await import(
  `${pathToFileURL(path.join(REPO_DIR, 'server.js')).href}?site-url-test=${Date.now()}`
);

const {
  flushScheduledWrites,
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
  flushScheduledWrites();
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

test('SITE_URL is used for generated absolute share URLs', async () => {
  const createResponse = await fetch(`${baseUrl}/api/sessions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      host: 'mesh-health-check:3090',
    },
    body: '{}',
  });

  assert.equal(createResponse.status, 201);
  const created = await createResponse.json();
  assert.equal(created.sharePath, `/share/${created.id}`);
  assert.equal(created.shareUrl, `https://mesh.example.org/check/share/${created.id}`);
});

test('SITE_URL is used for server-rendered public metadata', async () => {
  const response = await fetch(`${baseUrl}/share/example-session`, {
    headers: {
      host: 'mesh-health-check:3090',
    },
  });

  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<meta property="og:url" content="https:\/\/mesh\.example\.org\/check\/share\/example-session">/);
  assert.match(html, /<meta property="og:image" content="https:\/\/mesh\.example\.org\/check\/logo\.png">/);
});
