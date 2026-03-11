import { createHash } from 'node:crypto';

export const LOG_LEVELS = {
  debug: 10,
  info: 20,
};

export function normalizeLogLevel(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(LOG_LEVELS, normalized)
    ? normalized
    : 'info';
}

export function normalizeHex(value) {
  const normalized = String(value || '').trim().replace(/^0x/i, '').toLowerCase();
  if (!normalized || normalized.length % 2 !== 0) {
    return '';
  }
  return /^[0-9a-f]+$/.test(normalized) ? normalized : '';
}

export function normalizeKey(value) {
  return normalizeHex(value).toUpperCase();
}

export function shortKey(value, size = 6) {
  const normalized = normalizeKey(value);
  if (!normalized) {
    return '';
  }
  if (normalized.length <= size * 2) {
    return normalized;
  }
  return `${normalized.slice(0, size)}...${normalized.slice(-size)}`;
}

export function calculateChannelHash(secretHex) {
  const normalized = normalizeHex(secretHex);
  if (!normalized) {
    return '';
  }
  const digest = createHash('sha256').update(Buffer.from(normalized, 'hex')).digest();
  return digest.subarray(0, 1).toString('hex');
}

export function shouldDecodeChannel(configuredChannelHash, candidateChannelHash) {
  const configured = String(configuredChannelHash || '').trim().toLowerCase();
  if (!configured) {
    return true;
  }
  return String(candidateChannelHash || '').trim().toLowerCase() === configured;
}

export function parseObserverNameEntries(parsed) {
  const names = new Map();
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return names;
  }

  for (const [rawKey, rawName] of Object.entries(parsed)) {
    const key = normalizeKey(rawKey);
    const value = String(rawName || '').trim();
    if (key && value) {
      names.set(key, value);
    }
  }

  return names;
}

export function decodePathLenByte(pathLenByte) {
  const raw = Number(pathLenByte);
  if (!Number.isInteger(raw) || raw < 0 || raw > 255) {
    return null;
  }
  const selector = (raw >> 6) & 0x03;
  const hashSize = selector + 1;
  if (hashSize === 4) {
    return null;
  }
  const hopCount = raw & 0x3f;
  return {
    hashSize,
    hopCount,
    byteLength: hashSize * hopCount,
  };
}

export function normalizePathHop(value) {
  const normalized = normalizeHex(value).toUpperCase();
  return /^[0-9A-F]{2,6}$/.test(normalized) ? normalized : '';
}

export function encodePathHops(path = []) {
  const normalizedPath = path.map((value) => normalizePathHop(value)).filter(Boolean);
  if (normalizedPath.length === 0) {
    return {
      pathLenByte: 0,
      pathBytes: Buffer.alloc(0),
      hashSize: 1,
    };
  }

  const hashSize = normalizedPath[0].length / 2;
  if (!Number.isInteger(hashSize) || hashSize < 1 || hashSize > 3) {
    throw new Error('Path hops must be 1, 2, or 3 bytes each');
  }
  if (normalizedPath.some((hop) => hop.length !== hashSize * 2)) {
    throw new Error('All path hops must use the same byte width');
  }
  if (normalizedPath.length > 0x3f) {
    throw new Error('Path hop count exceeds MeshCore limit');
  }

  const selector = hashSize - 1;
  const pathLenByte = (selector << 6) | normalizedPath.length;
  return {
    pathLenByte,
    pathBytes: Buffer.from(normalizedPath.join(''), 'hex'),
    hashSize,
  };
}
