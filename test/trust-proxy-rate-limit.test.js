import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.resolve(TEST_DIR, '..');

test('rate limiting ignores forwarded addresses when trust proxy is disabled', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-health-proxy-test-'));
  const observerFile = path.join(tempDir, 'observer.json');
  const observerActivityFile = path.join(tempDir, 'observer-activity.json');
  const resultsFile = path.join(tempDir, 'session-results.json');
  fs.writeFileSync(observerFile, '{}\n', 'utf8');
  fs.writeFileSync(observerActivityFile, '{\n  "version": 1,\n  "observers": {}\n}\n', 'utf8');
  fs.writeFileSync(resultsFile, '{\n  "version": 1,\n  "sessions": []\n}\n', 'utf8');

  process.env.MESH_HEALTH_DISABLE_RUNTIME = 'true';
  process.env.TURNSTILE_ENABLED = 'false';
  process.env.TRUST_PROXY = 'false';
  process.env.SESSION_RATE_MAX = '1';
  process.env.OBSERVERS_FILE = observerFile;
  process.env.OBSERVER_ACTIVITY_FILE = observerActivityFile;
  process.env.RESULTS_FILE = resultsFile;

  const { flushScheduledWrites, server } = await import(
    `${pathToFileURL(path.join(REPO_DIR, 'server.js')).href}?proxy-test=${Date.now()}`
  );

  try {
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address();
    const url = `http://127.0.0.1:${port}/api/sessions`;
    const first = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '198.51.100.10',
      },
      body: '{}',
    });
    const second = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '203.0.113.20',
      },
      body: '{}',
    });

    assert.equal(first.status, 201);
    assert.equal(second.status, 429);
  } finally {
    flushScheduledWrites();
    if (server.listening) {
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
