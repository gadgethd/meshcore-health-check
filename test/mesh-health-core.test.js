import test from 'node:test';
import assert from 'node:assert/strict';

import {
  calculateChannelHash,
  decodePathLenByte,
  encodePathHops,
  normalizeHex,
  normalizeKey,
  normalizeLogLevel,
  normalizePathHop,
  parseObserverNameEntries,
  shouldDecodeChannel,
  shortKey,
} from '../lib/mesh-health-core.js';

test('normalizeLogLevel accepts debug and falls back to info', () => {
  assert.equal(normalizeLogLevel('debug'), 'debug');
  assert.equal(normalizeLogLevel('info'), 'info');
  assert.equal(normalizeLogLevel('verbose'), 'info');
  assert.equal(normalizeLogLevel(''), 'info');
});

test('normalizeHex and normalizeKey clean valid values and reject invalid ones', () => {
  assert.equal(normalizeHex('0xA1b2'), 'a1b2');
  assert.equal(normalizeKey('0xA1b2'), 'A1B2');
  assert.equal(normalizeHex('xyz'), '');
  assert.equal(normalizeHex('abc'), '');
});

test('calculateChannelHash matches the configured health-check secret', () => {
  assert.equal(calculateChannelHash('E6D973AAC5101145AD3A3F3A0B3D52EB'), '99');
});

test('shouldDecodeChannel only allows the configured channel hash', () => {
  assert.equal(shouldDecodeChannel('99', '99'), true);
  assert.equal(shouldDecodeChannel('99', '9a'), false);
  assert.equal(shouldDecodeChannel('', '9a'), true);
});

test('shortKey abbreviates long public keys', () => {
  assert.equal(
    shortKey('AF07FC2005E04D08DDA921E64985E62201BF974AE0B0E35084B804229ED11A2B'),
    'AF07FC...D11A2B',
  );
});

test('decodePathLenByte handles 1-byte, 2-byte, and 3-byte hop modes', () => {
  assert.deepEqual(decodePathLenByte(0x00), {
    hashSize: 1,
    hopCount: 0,
    byteLength: 0,
  });
  assert.deepEqual(decodePathLenByte(0x40), {
    hashSize: 2,
    hopCount: 0,
    byteLength: 0,
  });
  assert.deepEqual(decodePathLenByte(0x83), {
    hashSize: 3,
    hopCount: 3,
    byteLength: 9,
  });
  assert.equal(decodePathLenByte(0xc1), null);
});

test('encodePathHops preserves multi-byte hop grouping', () => {
  const encoded = encodePathHops(['3FA002', '860CCA', 'E0EED9']);
  assert.equal(encoded.pathLenByte, 0x83);
  assert.equal(encoded.hashSize, 3);
  assert.equal(encoded.pathBytes.toString('hex').toUpperCase(), '3FA002860CCAE0EED9');
  assert.equal(normalizePathHop('3fa002'), '3FA002');
});

test('parseObserverNameEntries loads valid pubkey to name mappings only', () => {
  const names = parseObserverNameEntries({
    af07fc2005e04d08dda921e64985e62201bf974ae0b0e35084b804229ed11a2b: 'Observer 01',
    invalid: 'ignore me',
    E6D973AAC5101145AD3A3F3A0B3D52EB: '',
  });

  assert.equal(names.size, 1);
  assert.equal(
    names.get('AF07FC2005E04D08DDA921E64985E62201BF974AE0B0E35084B804229ED11A2B'),
    'Observer 01',
  );
});
