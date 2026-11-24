import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

for (const setting of ['', 'false', 'true']) {
  const prefix = setting === 'true' ? 'NYHC1234' : 'MHC';
  test(`code length API, RF matching and persistence (ALLOW_LONGER_TEST_CODES=${setting || 'default'})`, () => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import os from 'node:os';
      import path from 'node:path';
      import crypto from 'node:crypto';
      import { syncBuiltinESMExports } from 'node:module';
      import { buildGroupTextEnvelope } from './test/support/build-meshcore-fixture.js';
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mhc-length-'));
      process.env.OBSERVERS_FILE = path.join(dir, 'observers.json');
      process.env.OBSERVER_ACTIVITY_FILE = path.join(dir, 'activity.json');
      process.env.RESULTS_FILE = path.join(dir, 'results.json');
      const { server, ingestMqttMessage, flushScheduledWrites } = await import('./server.js');
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const base = 'http://127.0.0.1:' + server.address().port;
      const create = (body) => fetch(base + '/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      try {
        const bootstrap = await (await fetch(base + '/api/bootstrap')).json();
        assert.deepEqual(bootstrap.codeOptions, { prefix: '${prefix}', minLength: 6, maxLength: ${setting === 'true' ? 16 : 6}, defaultLength: 6 });
        const legacy = await (await create({})).json();
        assert.match(legacy.code, /^${prefix}-[0-9A-F]{6}$/);
        for (const codeLength of [null, '6', '7', ' 7 ', '', true, false, [], {}, 6.5, 5, 17, -1, 0]) {
          const response = await create({ codeLength });
          assert.equal(response.status, 400, 'invalid length ' + JSON.stringify(codeLength));
        }
        const key = '1'.repeat(64);
        ingestMqttMessage('meshcore/BOS/' + key + '/status', Buffer.from(JSON.stringify({ name: 'Length Observer' })));
        const matchedSessions = [];
        for (let length = 6; length <= 16; length++) {
          const response = await create({ codeLength: length, expectedObserverKeys: [key] });
          assert.equal(response.status, ${setting === 'true'} || length === 6 ? 201 : 400, 'length ' + length);
          if (response.status !== 201) continue;
          const session = await response.json();
          assert.match(session.code, new RegExp('^${prefix}-[0-9A-F]{' + length + '}$'));
          assert.deepEqual(session.expectedObservers.map(o => o.key), [key]);
          // Actual encrypted RF fixture: no message padding, match the complete variable code.
          const envelope = buildGroupTextEnvelope({ secretHex: process.env.TEST_CHANNEL_SECRET, sender: 'Length Test', message: session.code, messageHash: length.toString(16).padStart(16, '0'), timestamp: 1760000000 + length });
          ingestMqttMessage('meshcore/BOS/' + key + '/packets', Buffer.from(JSON.stringify(envelope)));
          const retained = await (await fetch(base + '/api/sessions/' + session.id)).json();
          assert.equal(retained.code, session.code);
          assert.equal(retained.useCount, 1);
          assert.equal(retained.receipts.length, 1);
          assert.equal(retained.messageBody, session.code);
          matchedSessions.push(retained);
        }
        // Force collisions through the real generator; exhaustion must not fall back to a different length or duplicate.
        crypto.randomBytes = n => Buffer.alloc(n, 0xab);
        syncBuiltinESMExports();
        const length = ${setting === 'true' ? 15 : 6};
        const first = await (await create({ codeLength: length })).json();
        assert.equal(first.code, '${prefix}-' + 'AB'.repeat(8).slice(0, length));
        const collision = await create({ codeLength: length });
        assert.equal(collision.status, 503);
        await flushScheduledWrites();
        const saved = JSON.parse(fs.readFileSync(process.env.RESULTS_FILE, 'utf8'));
        assert.ok(saved.sessions.some(s => s.code === legacy.code));
        assert.ok(saved.sessions.some(s => s.code.length === ${prefix.length + 1} + length));
        // Disabling the capability after a restart must not invalidate retained longer results.
        process.env.ALLOW_LONGER_TEST_CODES = 'false';
        process.env.CODE_PREFIX = 'CHANGED';
        const reloaded = await import('./server.js?reload');
        await new Promise(resolve => reloaded.server.listen(0, '127.0.0.1', resolve));
        const reloadBase = 'http://127.0.0.1:' + reloaded.server.address().port;
        const restored = await (await fetch(reloadBase + '/api/sessions/' + first.id)).json();
        assert.equal(restored.code, first.code);
        assert.equal((await (await fetch(reloadBase + '/api/bootstrap')).json()).codeOptions.prefix, 'CHANGED');
        assert.match((await (await fetch(reloadBase + '/share/' + first.id)).text()), /session-code/);
        const oldCodeEnvelope = buildGroupTextEnvelope({ secretHex: process.env.TEST_CHANNEL_SECRET, sender: 'Prefix Restart', message: first.code, messageHash: 'abcdef0123456789', timestamp: 1760000100 });
        reloaded.ingestMqttMessage('meshcore/BOS/' + key + '/packets', Buffer.from(JSON.stringify(oldCodeEnvelope)));
        const afterRestartMatch = await (await fetch(reloadBase + '/api/sessions/' + first.id)).json();
        assert.equal(afterRestartMatch.code, first.code);
        assert.equal(afterRestartMatch.useCount, 1);
        for (const original of [legacy, ...matchedSessions]) {
          const retained = await (await fetch(reloadBase + '/api/sessions/' + original.id)).json();
          assert.equal(retained.code, original.code);
          assert.equal(retained.useCount, original.useCount);
          assert.equal(retained.messageBody, original.messageBody);
          assert.deepEqual(retained.receipts, original.receipts);
          assert.deepEqual(retained.expectedObservers, original.expectedObservers);
        }
        await new Promise(resolve => reloaded.server.close(resolve));
      } finally {
        await flushScheduledWrites();
        await new Promise(resolve => server.close(resolve));
        fs.rmSync(dir, { recursive: true, force: true });
      }
    `], {
      encoding: 'utf8', timeout: 30000,
      env: { ...process.env, CODE_PREFIX: prefix, ALLOW_LONGER_TEST_CODES: setting, MESH_HEALTH_DISABLE_RUNTIME: 'false', TURNSTILE_ENABLED: 'false', SESSION_RATE_MAX: '200', KNOWN_OBSERVERS: '', INITIAL_REGION: '', ALLOWED_REGIONS: '', ALLOWED_REGION_GROUPS: '', LOG_LEVEL: 'error', TEST_CHANNEL_SECRET: 'E6D973AAC5101145AD3A3F3A0B3D52EB' },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
}
