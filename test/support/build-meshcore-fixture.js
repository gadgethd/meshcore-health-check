import { createCipheriv, createHmac } from 'node:crypto';

import {
  calculateChannelHash,
  encodePathHops,
  normalizeHex,
} from '../../lib/mesh-health-core.js';

function encryptAesEcb(aesKey, plaintext) {
  const cipher = createCipheriv('aes-128-ecb', aesKey, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

export function buildGroupTextEnvelope({
  secretHex,
  sender,
  message,
  messageHash,
  timestamp,
  path = [],
  rssi = -12,
  snr = 7,
  duration = 42,
}) {
  const normalizedSecret = normalizeHex(secretHex);
  const channelHash = calculateChannelHash(normalizedSecret);
  const secretBytes = Buffer.from(normalizedSecret, 'hex');
  const aesKey = secretBytes.subarray(0, 16);
  const hmacKey = Buffer.alloc(32);
  secretBytes.copy(hmacKey, 0, 0, Math.min(secretBytes.length, 32));

  const decodedText = `${sender}: ${message}`;
  const messageBytes = Buffer.from(decodedText, 'utf8');
  const plaintextLength = 5 + messageBytes.length;
  const paddedLength = Math.ceil(plaintextLength / 16) * 16;
  const plaintext = Buffer.alloc(paddedLength);
  plaintext.writeUInt32LE(timestamp, 0);
  plaintext[4] = 0;
  messageBytes.copy(plaintext, 5);

  const encryptedBytes = encryptAesEcb(aesKey, plaintext);
  const macDigest = createHmac('sha256', hmacKey).update(encryptedBytes).digest();
  const macBytes = macDigest.subarray(0, 2);

  const { pathLenByte, pathBytes } = encodePathHops(path);
  const payloadBytes = Buffer.concat([
    Buffer.from(channelHash, 'hex'),
    macBytes,
    encryptedBytes,
  ]);

  const header = Buffer.from([0x15, pathLenByte]);
  const packetBytes = Buffer.concat([header, pathBytes, payloadBytes]);

  return {
    raw: packetBytes.toString('hex'),
    hash: messageHash,
    rssi,
    snr,
    duration,
  };
}
