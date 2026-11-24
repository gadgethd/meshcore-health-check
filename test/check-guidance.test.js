import test from 'node:test';
import assert from 'node:assert/strict';
import { checkGuidance } from '../public/check-guidance.js';

const base = { channel: '#health-check', connected: true, shared: false, missing: false };
const session = { code: 'MHC-A1B2C3', status: 'waiting', observedCount: 0, expectedCount: 2 };

test('instructions follow the selected session through waiting, receipt, expiry and a fresh code', () => {
  assert.match(checkGuidance({ ...base, session }).text, /MHC-A1B2C3.*#health-check/);
  const result = checkGuidance({ ...base, session: { ...session, status: 'active', observedCount: 1 } });
  assert.equal(result.step, 'results');
  assert.match(result.text, /1 of 2 selected observers/);
  assert.match(checkGuidance({ ...base, session: { ...session, status: 'expired', observedCount: 1 } }).text, /expired/);
  const fresh = checkGuidance({ ...base, session: { ...session, code: 'MHC-D4E5F6' } });
  assert.equal(fresh.step, 'send');
  assert.doesNotMatch(fresh.text, /A1B2C3|reported/);
});

test('offline and missing saved results do not claim a successful live check', () => {
  assert.match(checkGuidance({ ...base, session, connected: false }).text, /offline.*wait/);
  const saved = checkGuidance({ ...base, session, shared: true });
  assert.match(saved.text, /saved result/);
  assert.doesNotMatch(saved.text, /Paste|Send|reported this message/);
  assert.match(checkGuidance({ ...base, shared: true, missing: true }).text, /expired or is unavailable/);
});
