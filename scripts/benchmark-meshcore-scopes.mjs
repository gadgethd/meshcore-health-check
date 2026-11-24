// Synthetic local benchmark: no MQTT, operator roster, or application state.
// Run in the same Node 24 container as test/region-scopes.test.js.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import os from 'node:os';
import { recognizeMeshcoreScope } from '../lib/meshcore-scopes.js';

const { calcTransportCodeForRegion, transportCodeMatchesRegion } = createRequire(import.meta.url)('@michaelhart/meshcore-decoder');
const regions = Array.from({ length: 1024 }, (_, i) => '#Fictional-' + i);
const config = { enabled: true, regions };
const payloadBytes = Buffer.alloc(180, 0xab);
const packet = { routeType: 0, payloadType: 5, payloadBytes,
  transportCodes: [calcTransportCodeForRegion(regions[0], 5, payloadBytes), 54321] };
function previousRecognition() {
  const names = regions.filter(name => transportCodeMatchesRegion(
    name, packet.payloadType, packet.payloadBytes.toString('hex'), packet.transportCodes[0],
  ));
  return { state: names.length > 1 ? 'ambiguous' : names.length === 1 ? 'known' : 'unknown', names };
}
const expected = previousRecognition();
const prepareStart = performance.now();
assert.deepEqual(recognizeMeshcoreScope(config, packet), expected);
const coldMs = performance.now() - prepareStart;
const before = [], after = [];
for (let i = 0; i < 9; i++) {
  // Alternate order to reduce warmup/scheduling bias; verify actual results every time.
  for (const kind of i % 2 ? ['after', 'before'] : ['before', 'after']) {
    const start = performance.now();
    const value = kind === 'before' ? previousRecognition() : recognizeMeshcoreScope(config, packet);
    (kind === 'before' ? before : after).push(performance.now() - start);
    assert.deepEqual(value, expected);
  }
}
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const beforeMs = median(before), afterMs = median(after);
console.log(JSON.stringify({ node: process.version, cpu: os.cpus()[0].model,
  regions: regions.length, payloadBytes: payloadBytes.length, samples: before.length,
  coldRecognitionMs: coldMs, previousMedianMs: beforeMs, preparedMedianMs: afterMs,
  speedup: beforeMs / afterMs, savedPercent: 100 * (beforeMs - afterMs) / beforeMs,
  parity: 'all repeated candidate arrays and states identical', beforeMs: before, afterMs: after,
}, null, 2));
