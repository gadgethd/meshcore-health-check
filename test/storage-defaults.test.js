import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.resolve(TEST_DIR, '..');

test('default persistent file paths resolve under data/', async () => {
  const original = {
    MESH_HEALTH_DISABLE_RUNTIME: process.env.MESH_HEALTH_DISABLE_RUNTIME,
    OBSERVERS_FILE: process.env.OBSERVERS_FILE,
    OBSERVER_ACTIVITY_FILE: process.env.OBSERVER_ACTIVITY_FILE,
    RESULTS_FILE: process.env.RESULTS_FILE,
  };

  process.env.MESH_HEALTH_DISABLE_RUNTIME = 'true';
  process.env.OBSERVERS_FILE = '';
  process.env.OBSERVER_ACTIVITY_FILE = '';
  process.env.RESULTS_FILE = '';

  try {
    const module = await import(
      `${pathToFileURL(path.join(REPO_DIR, 'server.js')).href}?test=${Date.now()}`
    );

    assert.equal(
      module.OBSERVERS_FILE_PATH,
      path.join(REPO_DIR, 'data', 'observer.json'),
    );
    assert.equal(
      module.OBSERVER_ACTIVITY_FILE_PATH,
      path.join(REPO_DIR, 'data', 'observer-activity.json'),
    );
    assert.equal(
      module.RESULTS_FILE_PATH,
      path.join(REPO_DIR, 'data', 'session-results.json'),
    );
  } finally {
    if (original.MESH_HEALTH_DISABLE_RUNTIME === undefined) {
      delete process.env.MESH_HEALTH_DISABLE_RUNTIME;
    } else {
      process.env.MESH_HEALTH_DISABLE_RUNTIME = original.MESH_HEALTH_DISABLE_RUNTIME;
    }
    if (original.OBSERVERS_FILE === undefined) {
      delete process.env.OBSERVERS_FILE;
    } else {
      process.env.OBSERVERS_FILE = original.OBSERVERS_FILE;
    }
    if (original.OBSERVER_ACTIVITY_FILE === undefined) {
      delete process.env.OBSERVER_ACTIVITY_FILE;
    } else {
      process.env.OBSERVER_ACTIVITY_FILE = original.OBSERVER_ACTIVITY_FILE;
    }
    if (original.RESULTS_FILE === undefined) {
      delete process.env.RESULTS_FILE;
    } else {
      process.env.RESULTS_FILE = original.RESULTS_FILE;
    }
  }
});

test('observer retention defaults to disabled when unset', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-health-retention-default-test-'));
  const observerFile = path.join(tempDir, 'observer.json');
  const observerActivityFile = path.join(tempDir, 'observer-activity.json');
  const resultsFile = path.join(tempDir, 'session-results.json');
  fs.writeFileSync(observerFile, '{}\n', 'utf8');
  fs.writeFileSync(observerActivityFile, '{\n  "version": 1,\n  "observers": {}\n}\n', 'utf8');
  fs.writeFileSync(resultsFile, '{\n  "version": 1,\n  "sessions": []\n}\n', 'utf8');

  const envNames = [
    'MESH_HEALTH_DISABLE_RUNTIME',
    'TURNSTILE_ENABLED',
    'OBSERVERS_FILE',
    'OBSERVER_ACTIVITY_FILE',
    'RESULTS_FILE',
    'OBSERVER_RETENTION_SECONDS',
    'KNOWN_OBSERVERS',
  ];
  const previousEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  process.env.MESH_HEALTH_DISABLE_RUNTIME = 'true';
  process.env.TURNSTILE_ENABLED = 'false';
  process.env.OBSERVERS_FILE = observerFile;
  process.env.OBSERVER_ACTIVITY_FILE = observerActivityFile;
  process.env.RESULTS_FILE = resultsFile;
  delete process.env.OBSERVER_RETENTION_SECONDS;
  delete process.env.KNOWN_OBSERVERS;

  const serverModule = await import(
    `${pathToFileURL(path.join(REPO_DIR, 'server.js')).href}?retention-default=${Date.now()}`
  );
  const { flushScheduledWrites, server } = serverModule;
  let baseUrl = '';
  try {
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;
    const response = await fetch(`${baseUrl}/api/bootstrap`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.observerStats.retentionSeconds, 0);
  } finally {
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
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
});
