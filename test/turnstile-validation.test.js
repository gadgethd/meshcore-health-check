import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-health-turnstile-test-'));
const observerFile = path.join(tempDir, 'observer.json');
const observerActivityFile = path.join(tempDir, 'observer-activity.json');
const resultsFile = path.join(tempDir, 'session-results.json');
fs.writeFileSync(observerFile, '{}\n', 'utf8');
fs.writeFileSync(observerActivityFile, '{\n  "version": 1,\n  "observers": {}\n}\n', 'utf8');
fs.writeFileSync(resultsFile, '{\n  "version": 1,\n  "sessions": []\n}\n', 'utf8');

let verifierMode = 'html-error';
const verifier = http.createServer((request, response) => {
  if (verifierMode === 'timeout') {
    setTimeout(() => response.end('{"success":true}'), 5000);
    return;
  }
  if (verifierMode === 'html-error') {
    response.writeHead(502, { 'content-type': 'text/html' });
    response.end('<html>upstream failure</html>');
    return;
  }
  if (verifierMode === 'invalid-json') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('not-json');
    return;
  }
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(verifierMode === 'rejected' ? '{"success":false}' : '{"success":true}');
});

await new Promise((resolve) => verifier.listen(0, '127.0.0.1', resolve));
const verifierUrl = `http://127.0.0.1:${verifier.address().port}/verify`;

process.env.MESH_HEALTH_DISABLE_RUNTIME = 'true';
process.env.TURNSTILE_ENABLED = 'true';
process.env.TURNSTILE_SITE_KEY = 'site-key';
process.env.TURNSTILE_SECRET_KEY = 'secret-key';
process.env.TURNSTILE_API_URL = verifierUrl;
process.env.TURNSTILE_VERIFY_TIMEOUT_MS = '1000';
process.env.OBSERVERS_FILE = observerFile;
process.env.OBSERVER_ACTIVITY_FILE = observerActivityFile;
process.env.RESULTS_FILE = resultsFile;

const serverModule = await import(
  `${pathToFileURL(path.join(REPO_DIR, 'server.js')).href}?turnstile-validation=${Date.now()}`
);
const { flushScheduledWrites, server } = serverModule;
let baseUrl = '';

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  flushScheduledWrites();
  if (server.listening) {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
  verifier.closeAllConnections?.();
  await new Promise((resolve) => verifier.close(() => resolve()));
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('Turnstile upstream failures return bounded generic errors', async () => {
  verifierMode = 'html-error';
  const response = await fetch(`${baseUrl}/api/verify-turnstile`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'dummy-token' }),
  });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    success: false,
    error: 'verification_unavailable',
  });
});

test('Turnstile malformed and rejected JSON responses stay generic', async () => {
  verifierMode = 'invalid-json';
  const malformed = await fetch(`${baseUrl}/api/verify-turnstile`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'dummy-token' }),
  });
  assert.equal(malformed.status, 503);
  assert.equal((await malformed.json()).error, 'verification_unavailable');

  verifierMode = 'rejected';
  const rejected = await fetch(`${baseUrl}/api/verify-turnstile`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'dummy-token' }),
  });
  assert.equal(rejected.status, 400);
  assert.deepEqual(await rejected.json(), {
    success: false,
    error: 'verification_failed',
  });
});

test('Turnstile verification has a bounded upstream timeout', async () => {
  verifierMode = 'timeout';
  const startedAt = Date.now();
  const response = await fetch(`${baseUrl}/api/verify-turnstile`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'dummy-token' }),
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, 'verification_unavailable');
  assert.ok(Date.now() - startedAt < 3000);
});

test('explicitly enabled Turnstile configuration fails without both keys', async () => {
  const childEnv = {
    ...process.env,
    TURNSTILE_ENABLED: 'true',
    TURNSTILE_SITE_KEY: '',
    TURNSTILE_SECRET_KEY: '',
    MESH_HEALTH_DISABLE_RUNTIME: 'true',
    OBSERVERS_FILE: observerFile,
    OBSERVER_ACTIVITY_FILE: observerActivityFile,
    RESULTS_FILE: resultsFile,
  };
  const result = await new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['--input-type=module', '-e', "import('./server.js')"],
      { cwd: REPO_DIR, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stderr }));
  });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /TURNSTILE_ENABLED=true requires both/);
});
