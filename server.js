import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import express from 'express';
import mqtt from 'mqtt';
import { WebSocketServer } from 'ws';
import {
  calculateChannelHash,
  decodePathLenByte,
  normalizeHex,
  normalizeKey,
  normalizeLogLevel,
  normalizePathHop,
  parseObserverNameEntries,
  shortKey,
  shouldDecodeChannel,
} from './lib/mesh-health-core.js';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const {
  MeshCorePacketDecoder,
  PayloadType: MeshCorePayloadType,
} = require('meshcore-decoder-multibyte-patch');
const IS_MAIN_MODULE = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

function parseEnvFileLoose(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  const out = {};
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const equalsIndex = trimmed.indexOf('=');
    if (equalsIndex <= 0) {
      continue;
    }
    const key = trimmed.slice(0, equalsIndex).trim();
    let value = trimmed.slice(equalsIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) {
      out[key] = value;
    }
  }
  return out;
}

const localEnvPath = path.join(APP_DIR, '.env');
const localEnv = parseEnvFileLoose(localEnvPath);
for (const [key, value] of Object.entries(localEnv)) {
  if (process.env[key] === undefined) {
    process.env[key] = value;
  }
}

function envValue(name, fallback = '') {
  const localValue = process.env[name];
  if (typeof localValue === 'string' && localValue.trim() !== '') {
    return localValue.trim();
  }
  return fallback;
}

function envNumber(name, fallback) {
  const raw = envValue(name, '');
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envBool(name, fallback = false) {
  const raw = envValue(name, '').toLowerCase();
  if (!raw) {
    return fallback;
  }
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

function envList(name) {
  const raw = envValue(name, '');
  if (!raw) {
    return [];
  }
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function createLogger(levelName) {
  const LOG_LEVELS = {
    debug: 10,
    info: 20,
  };
  const threshold = LOG_LEVELS[levelName] || LOG_LEVELS.info;
  const write = (level, method, message) => {
    if ((LOG_LEVELS[level] || LOG_LEVELS.info) < threshold) {
      return;
    }
    method(message);
  };
  return {
    level: levelName,
    debug(message) {
      write('debug', console.log, message);
    },
    info(message) {
      write('info', console.log, message);
    },
    warn(message) {
      console.warn(message);
    },
  };
}

function ensureLeadingSlash(value) {
  if (!value) {
    return '/';
  }
  return value.startsWith('/') ? value : `/${value}`;
}

function buildMqttUrl() {
  const directUrl = envValue('MQTT_URL', '');
  if (directUrl) {
    return directUrl;
  }

  const host = envValue('MQTT_HOST', 'localhost');
  const port = envValue('MQTT_PORT', '1883');
  const transport = envValue('MQTT_TRANSPORT', 'tcp').toLowerCase();
  const tls = envBool('MQTT_TLS', false);
  const protocol = transport === 'websockets'
    ? (tls ? 'wss' : 'ws')
    : (tls ? 'mqtts' : 'mqtt');
  const wsPath = transport === 'websockets'
    ? ensureLeadingSlash(envValue('MQTT_WS_PATH', '/'))
    : '';

  return `${protocol}://${host}:${port}${wsPath}`;
}

function brokerLabel(urlString) {
  try {
    const parsed = new URL(urlString);
    return parsed.host;
  } catch {
    return urlString;
  }
}

function hashFromKeyPrefix(value) {
  const normalized = normalizeKey(value);
  if (normalized.length < 2) {
    return '';
  }
  return normalized.slice(0, 2);
}

function dedupe(items) {
  return [...new Set(items.filter(Boolean))];
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readStructuredFile(filePath) {
  if (!filePath) {
    return null;
  }
  const resolved = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(APP_DIR, filePath);
  if (!fs.existsSync(resolved)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (error) {
    logger.warn(`[config] failed to parse ${resolved}: ${error.message}`);
    return null;
  }
}

function resolveAppPath(filePath) {
  return path.isAbsolute(filePath)
    ? filePath
    : path.resolve(APP_DIR, filePath);
}

function parseObserversJson(filePath) {
  const resolved = resolveAppPath(filePath);
  if (!fs.existsSync(resolved)) {
    return new Map();
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    return parseObserverNameEntries(parsed);
  } catch (error) {
    logger.warn(`[config] failed to parse ${resolved}: ${error.message}`);
    return new Map();
  }
}

const LOG_LEVEL = normalizeLogLevel(envValue('LOG_LEVEL', 'info'));
const logger = createLogger(LOG_LEVEL);
const DISABLE_RUNTIME = envBool('MESH_HEALTH_DISABLE_RUNTIME', false);
const DISABLE_OBSERVER_FILE_WRITES = DISABLE_RUNTIME || envBool('DISABLE_OBSERVER_FILE_WRITES', false);
const PORT = envNumber('PORT', 3090);
const MQTT_URL = buildMqttUrl();
const MQTT_TOPICS = dedupe(envList('MQTT_TOPIC').length > 0
  ? envList('MQTT_TOPIC')
  : ['meshcore/BOS/#']);
const OBSERVERS_FILE = envValue('OBSERVERS_FILE', 'observer.json');
const OBSERVERS_FILE_PATH = resolveAppPath(OBSERVERS_FILE);
const APP_TITLE = envValue('APP_TITLE', 'Mesh Health Check');
const APP_EYEBROW = envValue('APP_EYEBROW', 'MeshCore Observer Coverage');
const APP_HEADLINE = envValue('APP_HEADLINE', 'Check your mesh reach.');
const APP_DESCRIPTION = envValue(
  'APP_DESCRIPTION',
  'Generate a test code, send it to the configured channel, and watch observer coverage build in real time.',
);
const APP_TITLE_OVERRIDE = envValue('APP_TITLE', '');
const TRUST_PROXY = envValue('TRUST_PROXY', '1');
const TURNSTILE_SITE_KEY = envValue('TURNSTILE_SITE_KEY', '');
const TURNSTILE_SECRET_KEY = envValue('TURNSTILE_SECRET_KEY', '');
const TURNSTILE_ENABLED = envBool(
  'TURNSTILE_ENABLED',
  Boolean(TURNSTILE_SITE_KEY && TURNSTILE_SECRET_KEY),
);
const TURNSTILE_API_URL = envValue(
  'TURNSTILE_API_URL',
  'https://challenges.cloudflare.com/turnstile/v0/siteverify',
);
const TURNSTILE_COOKIE_NAME = envValue(
  'TURNSTILE_COOKIE_NAME',
  'mesh_health_turnstile',
);
const TURNSTILE_TOKEN_TTL_SECONDS = Math.max(
  300,
  envNumber('TURNSTILE_TOKEN_TTL_SECONDS', 86400),
);
const TURNSTILE_BOT_BYPASS = envBool('TURNSTILE_BOT_BYPASS', true);
const TURNSTILE_BOT_ALLOWLIST = dedupe(
  (
    envValue(
      'TURNSTILE_BOT_ALLOWLIST',
      'discordbot,twitterbot,slackbot,facebookexternalhit,linkedinbot,telegrambot,whatsapp',
    )
  )
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean),
);
const TURNSTILE_VERIFY_RATE_WINDOW_MS = Math.max(
  60,
  envNumber('TURNSTILE_VERIFY_RATE_WINDOW_SECONDS', 600),
) * 1000;
const TURNSTILE_VERIFY_RATE_MAX = Math.max(
  1,
  envNumber('TURNSTILE_VERIFY_RATE_MAX', 10),
);
const SESSION_RATE_WINDOW_MS = Math.max(
  60,
  envNumber('SESSION_RATE_WINDOW_SECONDS', 600),
) * 1000;
const SESSION_RATE_MAX = Math.max(
  1,
  envNumber('SESSION_RATE_MAX', 30),
);
const OBSERVER_ACTIVE_WINDOW_MS = Math.max(
  60,
  envNumber('OBSERVER_ACTIVE_WINDOW_SECONDS', 900),
) * 1000;
const SESSION_TTL_MS = Math.max(60, envNumber('SESSION_TTL_SECONDS', 600)) * 1000;
const MAX_USES_PER_CODE = Math.max(1, envNumber('MAX_USES_PER_CODE', 3));
const KNOWN_OBSERVERS = dedupe(envList('KNOWN_OBSERVERS').map(normalizeKey));

const channelsConfig = readStructuredFile(
  envValue('CHANNELS_FILE', ''),
);
const channelHashToInfo = new Map();

if (channelsConfig && Array.isArray(channelsConfig.channels)) {
  for (const entry of channelsConfig.channels) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const secret = normalizeHex(entry.secret);
    const hashOverride = normalizeHex(entry.hash);
    const name = String(entry.name || entry.label || '').trim();
    let channelHash = '';
    if (secret) {
      channelHash = calculateChannelHash(secret);
    } else if (hashOverride) {
      channelHash = hashOverride;
    }
    if (!channelHash) {
      continue;
    }
    channelHashToInfo.set(channelHash, {
      hash: channelHash,
      name,
      secret,
    });
  }
}

const envTestChannelSecret = normalizeHex(envValue('TEST_CHANNEL_SECRET', ''));
const testChannelName = envValue('TEST_CHANNEL_NAME', 'health-check').toLowerCase();
let testChannelHash = envValue('TEST_CHANNEL_HASH', '').toLowerCase();
if (envTestChannelSecret) {
  const derivedHash = calculateChannelHash(envTestChannelSecret);
  if (derivedHash) {
    testChannelHash = testChannelHash || derivedHash;
    channelHashToInfo.set(derivedHash, {
      hash: derivedHash,
      name: testChannelName,
      secret: envTestChannelSecret,
    });
  }
}
if (!testChannelHash) {
  for (const info of channelHashToInfo.values()) {
    if (String(info.name || '').trim().toLowerCase() === testChannelName) {
      testChannelHash = info.hash;
      break;
    }
  }
}

function buildDecoderKeyCandidate(secretHex, channelHash = '') {
  const normalizedSecret = normalizeHex(secretHex);
  if (!normalizedSecret) {
    return null;
  }
  const secretBytes = Buffer.from(normalizedSecret, 'hex');
  if (secretBytes.length < 16) {
    return null;
  }
  const aesKey = secretBytes.subarray(0, 16);
  const hmacKey = Buffer.alloc(32);
  secretBytes.copy(hmacKey, 0, 0, Math.min(secretBytes.length, 32));
  return {
    secretHex: normalizedSecret,
    channelHash: String(channelHash || '').trim().toLowerCase(),
    aesKey,
    hmacKey,
  };
}

const decoderKeyCandidates = (() => {
  if (envTestChannelSecret) {
    const candidate = buildDecoderKeyCandidate(envTestChannelSecret, testChannelHash);
    if (candidate) {
      return [candidate];
    }
  }
  const fallback = testChannelHash ? channelHashToInfo.get(testChannelHash) : null;
  if (fallback?.secret) {
    const candidate = buildDecoderKeyCandidate(fallback.secret, testChannelHash);
    if (candidate) {
      return [candidate];
    }
  }
  return [];
})();

const meshPacketDecoderKeyStore = envTestChannelSecret
  ? MeshCorePacketDecoder.createKeyStore({
      channelSecrets: [envTestChannelSecret],
    })
  : null;

const nodeNames = parseObserversJson(OBSERVERS_FILE_PATH);
const appHtmlTemplate = fs.readFileSync(path.join(APP_DIR, 'public/index.html'), 'utf8');
const landingHtmlTemplate = fs.readFileSync(path.join(APP_DIR, 'public/landing.html'), 'utf8');
const observerState = new Map();
const sessions = new Map();
const messageToSession = new Map();
const rateLimitBuckets = new Map();
const turnstileAuthTokens = new Map();
let observerNamesWriteTimer = null;

function writeObserverNamesFile() {
  const entries = [...nodeNames.entries()].sort(([left], [right]) => left.localeCompare(right));
  const payload = Object.fromEntries(entries);
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  const tempPath = `${OBSERVERS_FILE_PATH}.tmp`;
  try {
    fs.writeFileSync(tempPath, body, 'utf8');
    fs.renameSync(tempPath, OBSERVERS_FILE_PATH);
  } catch (error) {
    if (error?.code === 'EBUSY' || error?.code === 'EXDEV') {
      fs.writeFileSync(OBSERVERS_FILE_PATH, body, 'utf8');
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // ignore cleanup failure
      }
      return;
    }
    throw error;
  }
}

function scheduleObserverNamesWrite() {
  if (DISABLE_OBSERVER_FILE_WRITES) {
    return;
  }
  if (observerNamesWriteTimer) {
    return;
  }
  observerNamesWriteTimer = setTimeout(() => {
    observerNamesWriteTimer = null;
    writeObserverNamesFile();
  }, 250);
}

if (!fs.existsSync(OBSERVERS_FILE_PATH)) {
  writeObserverNamesFile();
}

function createObserverRecord(observerKey) {
  return {
    key: observerKey,
    hash: hashFromKeyPrefix(observerKey),
    name: nodeNames.get(observerKey) || null,
    firstSeenAt: 0,
    lastPacketAt: 0,
    packetCount: 0,
  };
}

function ensureObserverRecord(observerKey) {
  const normalizedKey = normalizeKey(observerKey);
  if (!normalizedKey) {
    return null;
  }
  let observer = observerState.get(normalizedKey);
  if (!observer) {
    observer = createObserverRecord(normalizedKey);
    observerState.set(normalizedKey, observer);
  }
  if (!observer.name && nodeNames.has(normalizedKey)) {
    observer.name = nodeNames.get(normalizedKey);
  }
  return observer;
}

function primeObserverDirectory() {
  for (const key of nodeNames.keys()) {
    ensureObserverRecord(key);
  }
  for (const key of KNOWN_OBSERVERS) {
    ensureObserverRecord(key);
  }
}

primeObserverDirectory();

function parseCookies(cookieHeader) {
  const out = {};
  const source = String(cookieHeader || '');
  if (!source) {
    return out;
  }
  for (const part of source.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }
    const equalsIndex = trimmed.indexOf('=');
    if (equalsIndex <= 0) {
      continue;
    }
    const key = trimmed.slice(0, equalsIndex).trim();
    const value = trimmed.slice(equalsIndex + 1).trim();
    if (!key) {
      continue;
    }
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function requestOrigin(request) {
  const protocol = request.protocol || (request.secure ? 'https' : 'http');
  const host = request.get('host') || 'localhost';
  return `${protocol}://${host}`;
}

function embedTitle() {
  return APP_TITLE_OVERRIDE || APP_TITLE || APP_EYEBROW || `#${testChannelName}`;
}

function embedDescription() {
  const configured = String(APP_DESCRIPTION || '').trim();
  if (configured) {
    return configured;
  }
  return `MeshCore observer coverage for #${testChannelName}.`;
}

function renderHtmlTemplate(template, request, pageTitleSuffix = '') {
  const title = embedTitle();
  const description = embedDescription();
  const origin = requestOrigin(request);
  const url = `${origin}${request.originalUrl || request.url || '/'}`;
  const imageUrl = `${origin}/logo.png`;
  const htmlTitle = pageTitleSuffix ? `${title} ${pageTitleSuffix}` : title;

  return template
    .replaceAll('__APP_HTML_TITLE__', escapeHtml(htmlTitle))
    .replaceAll('__APP_META_TITLE__', escapeHtml(title))
    .replaceAll('__APP_META_DESCRIPTION__', escapeHtml(description))
    .replaceAll('__APP_META_URL__', escapeHtml(url))
    .replaceAll('__APP_META_IMAGE__', escapeHtml(imageUrl));
}

function clientAddress(requestLike) {
  const forwardedFor = requestLike.headers?.['x-forwarded-for'];
  if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
    return forwardedFor.split(',')[0].trim();
  }
  return (
    requestLike.ip ||
    requestLike.socket?.remoteAddress ||
    requestLike.connection?.remoteAddress ||
    'unknown'
  );
}

function isAllowlistedTurnstileBot(requestLike) {
  if (!TURNSTILE_ENABLED || !TURNSTILE_BOT_BYPASS) {
    return false;
  }
  const userAgent = String(requestLike.headers?.['user-agent'] || '').toLowerCase();
  if (!userAgent) {
    return false;
  }
  return TURNSTILE_BOT_ALLOWLIST.some((token) => token && userAgent.includes(token));
}

function rateLimit(namespace, maxRequests, windowMs) {
  return (request, response, next) => {
    const key = `${namespace}:${clientAddress(request)}`;
    const now = Date.now();
    const existing = rateLimitBuckets.get(key);
    if (!existing || existing.resetAt <= now) {
      rateLimitBuckets.set(key, {
        count: 1,
        resetAt: now + windowMs,
      });
      next();
      return;
    }

    existing.count += 1;
    if (existing.count <= maxRequests) {
      next();
      return;
    }

    const retryAfter = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
    response.setHeader('Retry-After', String(retryAfter));
    response.status(429).json({ error: 'rate_limited', retryAfter });
  };
}

function turnstileCookieIsSecure(request) {
  if (request.secure) {
    return true;
  }
  return String(request.headers?.['x-forwarded-proto'] || '').toLowerCase() === 'https';
}

function buildTurnstileCookieHeader(request, value, maxAgeSeconds) {
  const attributes = [
    `${TURNSTILE_COOKIE_NAME}=${encodeURIComponent(value)}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ];
  if (turnstileCookieIsSecure(request)) {
    attributes.push('Secure');
  }
  return attributes.join('; ');
}

function setTurnstileCookie(request, response, authToken) {
  response.setHeader(
    'Set-Cookie',
    buildTurnstileCookieHeader(
      request,
      authToken,
      TURNSTILE_TOKEN_TTL_SECONDS,
    ),
  );
}

function clearTurnstileCookie(request, response) {
  response.setHeader(
    'Set-Cookie',
    buildTurnstileCookieHeader(request, '', 0),
  );
}

function cleanupExpiredTurnstileTokens() {
  const now = Date.now();
  for (const [token, expiresAt] of [...turnstileAuthTokens.entries()]) {
    if (expiresAt <= now) {
      turnstileAuthTokens.delete(token);
    }
  }
}

function issueTurnstileAuthToken() {
  cleanupExpiredTurnstileTokens();
  const authToken = randomBytes(24).toString('base64url');
  turnstileAuthTokens.set(
    authToken,
    Date.now() + (TURNSTILE_TOKEN_TTL_SECONDS * 1000),
  );
  return authToken;
}

function extractTurnstileAuthToken(requestLike) {
  const cookies = parseCookies(requestLike.headers?.cookie || '');
  return String(cookies[TURNSTILE_COOKIE_NAME] || '').trim();
}

function hasTurnstileAccess(requestLike) {
  if (!TURNSTILE_ENABLED) {
    return true;
  }
  if (isAllowlistedTurnstileBot(requestLike)) {
    return true;
  }
  cleanupExpiredTurnstileTokens();
  const authToken = extractTurnstileAuthToken(requestLike);
  if (!authToken) {
    return false;
  }
  const expiresAt = turnstileAuthTokens.get(authToken);
  if (!expiresAt || expiresAt <= Date.now()) {
    turnstileAuthTokens.delete(authToken);
    return false;
  }
  return true;
}

async function verifyTurnstileToken(token, remoteIp = '') {
  if (!TURNSTILE_ENABLED || !TURNSTILE_SECRET_KEY) {
    return { success: false, error: 'turnstile_not_enabled' };
  }

  const body = new URLSearchParams({
    secret: TURNSTILE_SECRET_KEY,
    response: token,
  });
  if (remoteIp) {
    body.set('remoteip', remoteIp);
  }

  try {
    const response = await fetch(TURNSTILE_API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
    });
    const payload = await response.json();
    if (payload?.success) {
      return { success: true, error: '' };
    }
    return {
      success: false,
      error: Array.isArray(payload?.['error-codes'])
        ? payload['error-codes'].join(', ')
        : 'verification_failed',
    };
  } catch (error) {
    return { success: false, error: error.message || 'verification_error' };
  }
}

function parseEnvelope(payloadBuffer) {
  const text = payloadBuffer.toString('utf8').trim();
  if (!text) {
    return { raw: '', envelope: null };
  }
  if (/^[0-9a-f]+$/i.test(text) && text.length % 2 === 0) {
    return { raw: text, envelope: null };
  }
  if (text.startsWith('{') && text.endsWith('}')) {
    try {
      const envelope = JSON.parse(text);
      const raw = typeof envelope.raw === 'string'
        ? envelope.raw
        : typeof envelope.packet === 'string'
          ? envelope.packet
          : typeof envelope.hex === 'string'
            ? envelope.hex
            : '';
      return { raw, envelope };
    } catch {
      return { raw: '', envelope: null };
    }
  }
  return { raw: '', envelope: null };
}

function parseJsonObject(payloadBuffer) {
  const text = payloadBuffer.toString('utf8').trim();
  if (!text.startsWith('{') || !text.endsWith('}')) {
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function extractDeviceName(obj, topic = '') {
  if (!obj || typeof obj !== 'object') {
    return '';
  }

  for (const key of [
    'name',
    'device_name',
    'deviceName',
    'node_name',
    'nodeName',
    'display_name',
    'displayName',
    'callsign',
    'label',
  ]) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  if (topic.endsWith('/status')) {
    const origin = obj.origin;
    if (typeof origin === 'string' && origin.trim()) {
      return origin.trim();
    }
  }

  return '';
}

function parsePacketHex(rawHex) {
  const normalized = normalizeHex(rawHex);
  if (!normalized || normalized.length < 4) {
    return null;
  }
  const bytes = Buffer.from(normalized, 'hex');
  if (bytes.length < 2) {
    return null;
  }

  let offset = 0;
  const header = bytes[offset];
  const routeType = header & 0x03;
  const payloadType = (header >> 2) & 0x0F;
  offset += 1;

  if (routeType === 0 || routeType === 3) {
    if (bytes.length < offset + 4) {
      return null;
    }
    offset += 4;
  }

  if (bytes.length < offset + 1) {
    return null;
  }
  const pathInfo = decodePathLenByte(bytes[offset]);
  offset += 1;
  if (!pathInfo) {
    return null;
  }

  if (bytes.length < offset + pathInfo.byteLength) {
    return null;
  }
  const pathBytes = bytes.subarray(offset, offset + pathInfo.byteLength);
  const path = [];
  for (let index = 0; index < pathInfo.hopCount; index += 1) {
    const start = index * pathInfo.hashSize;
    const hop = normalizePathHop(
      pathBytes.subarray(start, start + pathInfo.hashSize).toString('hex'),
    );
    if (hop) {
      path.push(hop);
    }
  }
  offset += pathInfo.byteLength;

  if (bytes.length < offset) {
    return null;
  }
  return {
    routeType,
    payloadType,
    pathHashSize: pathInfo.hashSize,
    path,
    payloadBytes: bytes.subarray(offset),
  };
}

function parseGroupTextPayload(packet) {
  if (!packet || packet.payloadType !== 5) {
    return null;
  }
  const payloadBytes = packet.payloadBytes;
  if (!payloadBytes || payloadBytes.length < 4) {
    return null;
  }
  return {
    channelHash: payloadBytes.subarray(0, 1).toString('hex').toLowerCase(),
    macBytes: payloadBytes.subarray(1, 3),
    encryptedBytes: payloadBytes.subarray(3),
  };
}

function decryptAesEcbTruncated(aesKey, encryptedBytes) {
  if (!aesKey || aesKey.length !== 16 || !encryptedBytes || encryptedBytes.length === 0) {
    return null;
  }
  const paddedLength = Math.ceil(encryptedBytes.length / 16) * 16;
  const padded = Buffer.alloc(paddedLength);
  encryptedBytes.copy(padded);
  try {
    const decipher = createDecipheriv('aes-128-ecb', aesKey, null);
    decipher.setAutoPadding(false);
    const decrypted = Buffer.concat([decipher.update(padded), decipher.final()]);
    return decrypted.subarray(0, encryptedBytes.length);
  } catch {
    return null;
  }
}

function hasValidGroupTextMac(hmacKey, macBytes, encryptedBytes) {
  if (!hmacKey || hmacKey.length === 0 || !macBytes || macBytes.length < 2) {
    return false;
  }
  const digest = createHmac('sha256', hmacKey).update(encryptedBytes).digest();
  return macBytes[0] === digest[0] && macBytes[1] === digest[1];
}

function sanitizeDecodedText(value) {
  return String(value || '')
    .replace(/\uFFFD/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '')
    .replace(/\x00+$/g, '')
    .trim();
}

function evaluateDecodedGroupText(plaintextBytes) {
  if (!plaintextBytes || plaintextBytes.length < 6) {
    return null;
  }
  const timestamp = plaintextBytes.readUInt32LE(0);
  const year = new Date(timestamp * 1000).getUTCFullYear();
  if (year < 2023 || year > 2035) {
    return null;
  }
  const messageBytes = plaintextBytes.subarray(5);
  if (messageBytes.length === 0) {
    return null;
  }
  let printableCount = 0;
  for (const value of messageBytes.values()) {
    if ((value >= 32 && value <= 126) || value === 9 || value === 10 || value === 13) {
      printableCount += 1;
    }
  }
  const printableRatio = printableCount / messageBytes.length;
  if (printableRatio < 0.7) {
    return null;
  }

  const decoded = sanitizeDecodedText(messageBytes.toString('utf8'));
  if (!decoded) {
    return null;
  }

  const splitIndex = decoded.indexOf(': ');
  let sender = '';
  let message = decoded;
  if (splitIndex > 0 && splitIndex < 50) {
    const maybeSender = decoded.slice(0, splitIndex).trim();
    if (maybeSender && !/[:\[\]]/.test(maybeSender)) {
      sender = maybeSender;
      message = decoded.slice(splitIndex + 2).trim();
    }
  }

  if (!message) {
    return null;
  }

  return {
    timestamp,
    sender,
    message,
    score: printableRatio + (decoded.includes(': ') ? 0.35 : 0),
  };
}

function tryDecodeGroupText(groupPayload) {
  if (!groupPayload || decoderKeyCandidates.length === 0) {
    return null;
  }
  if (!shouldDecodeChannel(testChannelHash, groupPayload.channelHash)) {
    return null;
  }
  let bestWeakMatch = null;

  for (const candidate of decoderKeyCandidates) {
    const plaintext = decryptAesEcbTruncated(candidate.aesKey, groupPayload.encryptedBytes);
    if (!plaintext) {
      continue;
    }
    const decoded = evaluateDecodedGroupText(plaintext);
    if (!decoded) {
      continue;
    }
    const macValid = hasValidGroupTextMac(
      candidate.hmacKey,
      groupPayload.macBytes,
      groupPayload.encryptedBytes,
    );
    const result = {
      channelHash: groupPayload.channelHash,
      sender: decoded.sender,
      message: decoded.message,
      timestamp: decoded.timestamp,
      macValid,
      score: decoded.score,
    };
    if (macValid) {
      return result;
    }
    if (!bestWeakMatch || result.score > bestWeakMatch.score) {
      bestWeakMatch = result;
    }
  }
  return bestWeakMatch;
}

function decodeMeshPacket(rawHex) {
  const normalized = normalizeHex(rawHex);
  if (!normalized) {
    return null;
  }
  try {
    return MeshCorePacketDecoder.decode(
      normalized,
      meshPacketDecoderKeyStore ? { keyStore: meshPacketDecoderKeyStore } : undefined,
    );
  } catch (error) {
    logger.debug(`[mqtt] packet decoder exception: ${error.message || error}`);
    return null;
  }
}

function createCode() {
  return `MHC-${randomBytes(3).toString('hex').toUpperCase()}`;
}

function activeObserverKeys(now = Date.now()) {
  const keys = [];
  for (const observer of observerState.values()) {
    if (now - observer.lastPacketAt <= OBSERVER_ACTIVE_WINDOW_MS) {
      keys.push(observer.key);
    }
  }
  return dedupe(keys.sort());
}

function defaultObserverTarget() {
  if (KNOWN_OBSERVERS.length > 0) {
    return {
      keys: [...KNOWN_OBSERVERS],
      source: 'configured',
    };
  }
  return {
    keys: activeObserverKeys(),
    source: 'active-window',
  };
}

function healthLabel(percent) {
  if (percent >= 85) {
    return 'VERY HEALTHY';
  }
  if (percent >= 60) {
    return 'GOOD';
  }
  if (percent >= 35) {
    return 'FAIR';
  }
  return 'POOR';
}

function serializeObserver(observer) {
  return {
    key: observer.key,
    hash: observer.hash,
    label: observer.name || shortKey(observer.key),
    name: observer.name || null,
    shortKey: shortKey(observer.key),
    packetCount: observer.packetCount,
    firstSeenAt: observer.firstSeenAt,
    lastPacketAt: observer.lastPacketAt,
    isActive: Date.now() - observer.lastPacketAt <= OBSERVER_ACTIVE_WINDOW_MS,
  };
}

function observerDirectory() {
  const defaultKeys = new Set(defaultObserverTarget().keys);
  return [...observerState.values()]
    .sort((left, right) => {
      const leftDefault = defaultKeys.has(left.key) ? 1 : 0;
      const rightDefault = defaultKeys.has(right.key) ? 1 : 0;
      if (leftDefault !== rightDefault) {
        return rightDefault - leftDefault;
      }
      const leftLabel = String(left.name || shortKey(left.key));
      const rightLabel = String(right.name || shortKey(right.key));
      const byLabel = leftLabel.localeCompare(rightLabel);
      if (byLabel !== 0) {
        return byLabel;
      }
      return left.key.localeCompare(right.key);
    })
    .map(serializeObserver);
}

function serializeSession(session) {
  const allReports = [...session.receipts.values()]
    .sort((left, right) => left.firstSeenAt - right.firstSeenAt)
    .map((report) => {
      const observer = observerState.get(report.observerKey);
      return {
        observerKey: report.observerKey,
        observerHash: report.observerHash,
        observerLabel: observer?.name || report.observerLabel,
        observerName: observer?.name || report.observerName,
        observerShortKey: shortKey(report.observerKey),
        firstSeenAt: report.firstSeenAt,
        lastSeenAt: report.lastSeenAt,
        count: report.count,
        topic: report.topic,
        messageHash: report.messageHash,
        packetType: report.packetType,
        channelName: report.channelName,
        rssi: report.rssi,
        snr: report.snr,
        duration: report.duration,
        path: report.path,
      };
    });

  const expected = dedupe((session.expectedObserverKeys || []).map(normalizeKey));
  const reports = session.allowlistEnabled && expected.length > 0
    ? allReports.filter((report) => expected.includes(normalizeKey(report.observerKey)))
    : allReports;
  const seen = dedupe(reports.map((report) => normalizeKey(report.observerKey)));
  const denominator = Math.max(1, expected.length, seen.length);
  const percent = Math.round((seen.length / denominator) * 100);

  return {
    id: session.id,
    code: session.code,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    status: session.status,
    instructions: `Send ${session.code} to #${testChannelName}`,
    useCount: session.useCount,
    maxUses: session.maxUses,
    usesRemaining: Math.max(0, session.maxUses - session.useCount),
    allowlistEnabled: Boolean(session.allowlistEnabled),
    messageHash: session.messageHash,
    matchedAt: session.matchedAt,
    sender: session.sender,
    messageBody: session.messageBody,
    channelHash: session.channelHash,
    channelName: session.channelName,
    observedCount: seen.length,
    expectedCount: denominator,
    healthPercent: percent,
    healthLabel: healthLabel(percent),
    expectedObserverSource: session.expectedObserverSource,
    expectedObservers: expected.map((key) => {
      const observer = observerState.get(key);
      return {
        key,
        hash: hashFromKeyPrefix(key),
        label: observer?.name || shortKey(key),
        seen: seen.includes(key),
      };
    }),
    receipts: reports,
  };
}

function snapshotPayload() {
  const directory = observerDirectory();
  const activeObservers = directory.filter((observer) => observer.isActive);
  const defaultTarget = defaultObserverTarget();

  return {
    serverTime: Date.now(),
    site: {
      title: APP_TITLE,
      eyebrow: APP_EYEBROW,
      headline: APP_HEADLINE,
      description: APP_DESCRIPTION,
    },
    mqtt: {
      connected: mqttConnected,
      broker: brokerLabel(MQTT_URL),
      topics: MQTT_TOPICS,
    },
    turnstile: {
      enabled: TURNSTILE_ENABLED,
      siteKey: TURNSTILE_ENABLED ? TURNSTILE_SITE_KEY : '',
    },
    observerStats: {
      configuredCount: KNOWN_OBSERVERS.length,
      activeCount: activeObservers.length,
      windowSeconds: Math.round(OBSERVER_ACTIVE_WINDOW_MS / 1000),
    },
    defaultObserverKeys: defaultTarget.keys,
    defaultObserverSource: defaultTarget.source,
    observerDirectory: directory,
    activeObservers,
    testChannel: {
      name: testChannelName,
      hash: testChannelHash || null,
      configured: Boolean(testChannelHash),
    },
  };
}

function serializeBootstrap(request) {
  return {
    ...snapshotPayload(),
    turnstile: {
      enabled: TURNSTILE_ENABLED,
      siteKey: TURNSTILE_ENABLED ? TURNSTILE_SITE_KEY : '',
      verified: hasTurnstileAccess(request),
    },
  };
}

function touchObserver(observerKey) {
  const observer = ensureObserverRecord(observerKey);
  if (!observer) {
    return null;
  }
  const now = Date.now();
  if (!observer.firstSeenAt) {
    observer.firstSeenAt = now;
  }
  observer.lastPacketAt = now;
  observer.packetCount += 1;
  return observer;
}

function updateObserverName(observerKey, name) {
  const normalizedKey = normalizeKey(observerKey);
  const cleanName = String(name || '').trim();
  if (!normalizedKey || !cleanName) {
    return false;
  }
  const previous = nodeNames.get(normalizedKey) || '';
  const observer = ensureObserverRecord(normalizedKey);
  if (!observer) {
    return false;
  }
  const changed = previous !== cleanName || observer.name !== cleanName;
  nodeNames.set(normalizedKey, cleanName);
  observer.name = cleanName;
  if (changed) {
    logger.debug(`[observer] name ${normalizedKey} -> ${cleanName}`);
    scheduleObserverNamesWrite();
  }
  return changed;
}

function handleObserverMetadata(topic, observerKey, payloadBuffer) {
  const observer = touchObserver(observerKey);
  if (!observer) {
    return false;
  }

  const parsed = parseJsonObject(payloadBuffer);
  if (!parsed) {
    return false;
  }

  let changed = false;
  const originId = normalizeKey(parsed.origin_id || parsed.originId || '');
  if (originId && originId !== observer.key) {
    changed = updateObserverName(originId, extractDeviceName(parsed, topic)) || changed;
  }

  const extractedName = extractDeviceName(parsed, topic);
  if (extractedName) {
    changed = updateObserverName(observer.key, extractedName) || changed;
  }

  return changed;
}

function matchSessionByCode(messageText) {
  const body = String(messageText || '').trim();
  if (!body) {
    return null;
  }
  const now = Date.now();
  const availableSessions = [...sessions.values()]
    .filter((session) =>
      session.status !== 'expired' &&
      now < session.expiresAt &&
      session.useCount < session.maxUses
    )
    .sort((left, right) => right.createdAt - left.createdAt);
  for (const session of availableSessions) {
    const regex = new RegExp(`\\b${escapeRegExp(session.code)}\\b`, 'i');
    if (regex.test(body)) {
      return session;
    }
  }
  return null;
}

function expectedObserversForSession() {
  return defaultObserverTarget();
}

function explicitObserverAllowlist(requestedKeys = []) {
  const normalized = dedupe(
    (Array.isArray(requestedKeys) ? requestedKeys : [])
      .map(normalizeKey)
      .filter(Boolean),
  );
  if (normalized.length === 0) {
    return {
      keys: [],
      source: '',
      enabled: false,
    };
  }
  const validKeys = normalized.filter((key) => observerState.has(key));
  return {
    keys: validKeys,
    source: validKeys.length === 1 ? 'selected observer' : 'selected observers',
    enabled: validKeys.length > 0,
  };
}

function maybeMatchSession(packetInfo) {
  if (!packetInfo.messageHash || !packetInfo.messageBody) {
    return null;
  }
  const mappedSessionId = messageToSession.get(packetInfo.messageHash);
  if (mappedSessionId) {
    return sessions.get(mappedSessionId) || null;
  }
  const session = matchSessionByCode(packetInfo.messageBody);
  if (!session) {
    return null;
  }
  const isNewUse = session.messageHash !== packetInfo.messageHash;
  if (isNewUse) {
    if (session.messageHash) {
      messageToSession.delete(session.messageHash);
    }
    session.receipts = new Map();
    session.useCount += 1;
  }
  session.status = session.useCount >= session.maxUses ? 'exhausted' : 'active';
  session.messageHash = packetInfo.messageHash;
  session.matchedAt = packetInfo.seenAt;
  session.messageBody = packetInfo.messageBody;
  session.sender = packetInfo.sender;
  session.channelHash = packetInfo.channelHash;
  session.channelName = packetInfo.channelName;
  if (!Array.isArray(session.expectedObserverKeys) || session.expectedObserverKeys.length === 0) {
    session.expectedObserverKeys = [packetInfo.observerKey];
    session.expectedObserverSource = 'first-observer';
  }
  messageToSession.set(packetInfo.messageHash, session.id);
  return session;
}

function recordReceipt(session, packetInfo) {
  const existing = session.receipts.get(packetInfo.observerKey);
  const observer = observerState.get(packetInfo.observerKey);
  const label = observer?.name || shortKey(packetInfo.observerKey);
  if (existing) {
    existing.lastSeenAt = packetInfo.seenAt;
    existing.count += 1;
    existing.path = [...packetInfo.path];
    existing.topic = packetInfo.topic;
    existing.rssi = packetInfo.rssi;
    existing.snr = packetInfo.snr;
    existing.duration = packetInfo.duration;
    existing.channelName = packetInfo.channelName;
    return true;
  }

  session.receipts.set(packetInfo.observerKey, {
    observerKey: packetInfo.observerKey,
    observerHash: packetInfo.observerHash,
    observerLabel: label,
    observerName: observer?.name || null,
    firstSeenAt: packetInfo.seenAt,
    lastSeenAt: packetInfo.seenAt,
    count: 1,
    topic: packetInfo.topic,
    messageHash: packetInfo.messageHash,
    packetType: packetInfo.packetType,
    channelName: packetInfo.channelName,
    rssi: packetInfo.rssi,
    snr: packetInfo.snr,
    duration: packetInfo.duration,
    path: [...packetInfo.path],
  });
  return true;
}

function pruneState() {
  const now = Date.now();
  let changed = false;

  cleanupExpiredTurnstileTokens();

  for (const session of sessions.values()) {
    if (session.status !== 'expired' && now >= session.expiresAt) {
      session.status = 'expired';
      changed = true;
    }
  }

  for (const [sessionId, session] of [...sessions.entries()]) {
    const maxAge = session.status === 'matched'
      ? (SESSION_TTL_MS * 4)
      : (SESSION_TTL_MS * 2);
    if (now - session.createdAt > maxAge) {
      sessions.delete(sessionId);
      if (session.messageHash) {
        messageToSession.delete(session.messageHash);
      }
      changed = true;
    }
  }

  return changed;
}

function channelDisplay(channelHash) {
  const normalized = String(channelHash || '').trim().toLowerCase();
  if (!normalized) {
    return '';
  }
  return channelHashToInfo.get(normalized)?.name || normalized;
}

function handlePacketMessage(topic, observerKey, payloadBuffer) {
  const observer = touchObserver(observerKey);
  if (!observer) {
    return;
  }

  const { raw, envelope } = parseEnvelope(payloadBuffer);
  if (!raw) {
    return;
  }

  const packet = decodeMeshPacket(raw);
  if (!packet?.isValid) {
    if (packet?.errors?.length) {
      logger.debug(
        `[mqtt] packet parse failed on ${shortKey(observer.key)}: ${packet.errors.join('; ')}`,
      );
    }
    return;
  }

  const path = Array.isArray(packet.path)
    ? packet.path.map((value) => normalizePathHop(value)).filter(Boolean)
    : [];
  if (observer.hash && path[path.length - 1] !== observer.hash) {
    path.push(observer.hash);
  }

  if (packet.payloadType !== MeshCorePayloadType.GroupText || !packet.payload?.decoded) {
    return;
  }
  const groupPayload = packet.payload.decoded;
  if (!shouldDecodeChannel(testChannelHash, groupPayload.channelHash)) {
    logger.debug(
      `[mqtt] ignore channel ${groupPayload.channelHash || 'unknown'} on ${shortKey(observer.key)}`,
    );
    return;
  }
  const decodedGroup = groupPayload?.decrypted
    ? {
        channelHash: groupPayload.channelHash,
        sender: String(groupPayload.decrypted.sender || '').trim(),
        message: String(groupPayload.decrypted.message || '').trim(),
        timestamp: Number(groupPayload.decrypted.timestamp || 0),
        macValid: true,
      }
    : null;
  const channelHash = decodedGroup?.channelHash || groupPayload?.channelHash || '';
  const channelName = channelDisplay(channelHash);
  const messageBody = String(decodedGroup?.message || '').trim();
  const sender = String(decodedGroup?.sender || '').trim();
  const messageHash = String(
    envelope?.hash || envelope?.message_hash || envelope?.messageHash || packet.messageHash || '',
  ).trim();

  if (!decodedGroup) {
    logger.debug(
      `[mqtt] target channel decode failed on ${shortKey(observer.key)} (${messageHash || 'no-hash'})`,
    );
  }
  if (!messageHash) {
    logger.debug(
      `[mqtt] target channel packet missing message hash on ${shortKey(observer.key)}`,
    );
  }
  if (decodedGroup && !messageBody) {
    logger.debug(
      `[mqtt] target channel packet has empty message body on ${shortKey(observer.key)} (${messageHash || 'no-hash'})`,
    );
  }

  const packetInfo = {
    observerKey: observer.key,
    observerHash: observer.hash,
    topic,
    seenAt: Date.now(),
    messageHash,
    messageBody,
    sender,
    channelHash,
    channelName,
    path,
    packetType: packet.payloadType,
    rssi: Number.isFinite(Number(envelope?.rssi)) ? Number(envelope.rssi) : null,
    snr: Number.isFinite(Number(envelope?.snr)) ? Number(envelope.snr) : null,
    duration: Number.isFinite(Number(envelope?.duration))
      ? Number(envelope.duration)
      : null,
  };

  let session = null;
  const isTestChannel = testChannelHash
    ? shouldDecodeChannel(testChannelHash, channelHash)
    : channelName.toLowerCase() === testChannelName;
  const hadExistingMapping = messageHash ? messageToSession.has(messageHash) : false;

  if (isTestChannel && messageBody) {
    session = maybeMatchSession(packetInfo);
    if (session && !hadExistingMapping) {
      logger.info(
        `[session] matched ${session.code} on ${shortKey(observer.key)} (${messageHash || 'no-hash'})`,
      );
    } else if (!session) {
      logger.debug(
        `[mqtt] target channel packet did not match any active code on ${shortKey(observer.key)} (${messageHash || 'no-hash'})`,
      );
    }
  }
  if (!session && messageHash && messageToSession.has(messageHash)) {
    session = sessions.get(messageToSession.get(messageHash)) || null;
  }
  if (!session || session.status === 'expired') {
    return;
  }

  if (!session.channelName && channelName) {
    session.channelName = channelName;
  }
  if (!session.messageBody && messageBody) {
    session.messageBody = messageBody;
  }
  if (!session.sender && sender) {
    session.sender = sender;
  }

  if (recordReceipt(session, packetInfo)) {
    logger.debug(
      `[session] receipt ${session.code} from ${shortKey(packetInfo.observerKey)} (${messageHash || 'no-hash'})`,
    );
    broadcastSnapshot(true);
  }
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', TRUST_PROXY);
app.use(express.json());
app.use((request, response, next) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Permissions-Policy', 'camera=(), geolocation=(), microphone=()');
  response.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "base-uri 'self'",
      "connect-src 'self' ws: wss:",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "frame-src https://challenges.cloudflare.com",
      "img-src 'self' data:",
      "object-src 'none'",
      "script-src 'self' https://challenges.cloudflare.com",
      "style-src 'self' 'unsafe-inline'",
    ].join('; '),
  );
  if (request.secure) {
    response.setHeader(
      'Strict-Transport-Security',
      'max-age=15552000; includeSubDomains',
    );
  }
  next();
});
app.use(express.static(path.join(APP_DIR, 'public'), { index: false }));

app.get('/api/bootstrap', (request, response) => {
  response.json(serializeBootstrap(request));
});

app.post(
  '/api/verify-turnstile',
  rateLimit('turnstile-verify', TURNSTILE_VERIFY_RATE_MAX, TURNSTILE_VERIFY_RATE_WINDOW_MS),
  async (request, response) => {
    if (!TURNSTILE_ENABLED) {
      response.status(400).json({ success: false, error: 'turnstile_not_enabled' });
      return;
    }

    const token = String(request.body?.token || '').trim();
    if (!token) {
      response.status(400).json({ success: false, error: 'token_required' });
      return;
    }

    const result = await verifyTurnstileToken(token, clientAddress(request));
    if (!result.success) {
      clearTurnstileCookie(request, response);
      response.status(400).json({
        success: false,
        error: result.error || 'verification_failed',
      });
      return;
    }

    const authToken = issueTurnstileAuthToken();
    setTurnstileCookie(request, response, authToken);
    response.json({ success: true });
  },
);

app.post(
  '/api/sessions',
  rateLimit('session-create', SESSION_RATE_MAX, SESSION_RATE_WINDOW_MS),
  (request, response) => {
    if (!hasTurnstileAccess(request)) {
      response.status(403).json({ error: 'turnstile_required' });
      return;
    }
    const now = Date.now();
    const requestedAllowlist = explicitObserverAllowlist(request.body?.expectedObserverKeys);
    const defaultExpected = expectedObserversForSession();
    const expected = requestedAllowlist.enabled ? requestedAllowlist : defaultExpected;
    const session = {
      id: randomUUID(),
      code: createCode(),
      createdAt: now,
      expiresAt: now + SESSION_TTL_MS,
      status: 'waiting',
      useCount: 0,
      maxUses: MAX_USES_PER_CODE,
      messageHash: '',
      matchedAt: 0,
      messageBody: '',
      sender: '',
      channelHash: '',
      channelName: '',
      allowlistEnabled: requestedAllowlist.enabled,
      expectedObserverKeys: expected.keys.length > 0 ? expected.keys : [],
      expectedObserverSource: expected.source || '',
      receipts: new Map(),
    };
    sessions.set(session.id, session);
    logger.info(`[session] created ${session.code}`);
    broadcastSnapshot(true);
    response.status(201).json(serializeSession(session));
  },
);

app.get('/api/sessions/:sessionId', (request, response) => {
  const session = sessions.get(request.params.sessionId);
  if (!session) {
    response.status(404).json({ error: 'session_not_found' });
    return;
  }
  response.json(serializeSession(session));
});

function sendApp(request, response) {
  response.type('html').send(renderHtmlTemplate(appHtmlTemplate, request));
}

function sendLanding(request, response) {
  response.type('html').send(renderHtmlTemplate(landingHtmlTemplate, request, 'Verification'));
}

app.get('/', (request, response) => {
  if (TURNSTILE_ENABLED && !hasTurnstileAccess(request)) {
    sendLanding(request, response);
    return;
  }
  response.redirect('/app');
});

app.get('/app', (request, response) => {
  if (TURNSTILE_ENABLED && !hasTurnstileAccess(request)) {
    response.redirect('/');
    return;
  }
  sendApp(request, response);
});

app.get('*', (request, response) => {
  if (TURNSTILE_ENABLED && !hasTurnstileAccess(request)) {
    response.redirect('/');
    return;
  }
  sendApp(request, response);
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

let mqttClient = null;
let mqttConnected = false;
let lastSnapshotSentAt = 0;
let pruneInterval = null;

function broadcastSnapshot(force = false) {
  const now = Date.now();
  if (!force && now - lastSnapshotSentAt < 1000) {
    return;
  }
  lastSnapshotSentAt = now;
  const payload = JSON.stringify({
    type: 'snapshot',
    data: snapshotPayload(),
  });
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(payload);
    }
  }
}

wss.on('connection', (socket) => {
  socket.send(JSON.stringify({
    type: 'snapshot',
    data: snapshotPayload(),
  }));
});

server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

function startMqtt() {
  const options = {
    clientId: envValue(
      'MQTT_CLIENT_ID',
      `mesh-health-${randomBytes(3).toString('hex')}`,
    ),
    clean: true,
    reconnectPeriod: 5000,
    connectTimeout: 10000,
  };

  const username = envValue('MQTT_USERNAME', '');
  const password = envValue('MQTT_PASSWORD', '');
  if (username) {
    options.username = username;
    options.password = password;
  }

  mqttClient = mqtt.connect(MQTT_URL, options);

  mqttClient.on('connect', () => {
    mqttConnected = true;
    logger.info(`[mqtt] connected ${brokerLabel(MQTT_URL)}`);
    for (const topic of MQTT_TOPICS) {
      mqttClient.subscribe(topic, (error) => {
        if (error) {
          logger.warn(`[mqtt] subscribe failed ${topic}: ${error.message}`);
          return;
        }
        logger.info(`[mqtt] subscribed ${topic}`);
      });
    }
    broadcastSnapshot(true);
  });

  mqttClient.on('reconnect', () => {
    mqttConnected = false;
    broadcastSnapshot(true);
  });

  mqttClient.on('close', () => {
    mqttConnected = false;
    broadcastSnapshot(true);
  });

  mqttClient.on('error', (error) => {
    mqttConnected = false;
    logger.warn(`[mqtt] ${error.message}`);
    broadcastSnapshot(true);
  });

  mqttClient.on('message', ingestMqttMessage);
}

function startRuntime() {
  if (pruneInterval) {
    return;
  }
  pruneInterval = setInterval(() => {
    const changed = pruneState();
    if (changed) {
      broadcastSnapshot(true);
    } else {
      broadcastSnapshot(false);
    }
  }, 10000);
  startMqtt();

  server.listen(PORT, () => {
    logger.info(`[web] listening on http://localhost:${PORT}`);
    logger.info(
      `[web] using broker ${brokerLabel(MQTT_URL)} and ${
        testChannelHash ? `#${testChannelName} (${testChannelHash})` : `#${testChannelName}`
      }`,
    );
    if (!decoderKeyCandidates.length) {
      logger.warn('[web] no decoder key configured for the test channel');
    }
    logger.info(`[web] log level ${logger.level}`);
  });
}

export function resetTestState() {
  if (observerNamesWriteTimer) {
    clearTimeout(observerNamesWriteTimer);
    observerNamesWriteTimer = null;
  }
  sessions.clear();
  messageToSession.clear();
  rateLimitBuckets.clear();
  turnstileAuthTokens.clear();
  observerState.clear();
  primeObserverDirectory();
  lastSnapshotSentAt = 0;
}

export function ingestMqttMessage(topic, payload) {
  const parts = String(topic || '').split('/');
  const streamType = parts[parts.length - 1] || '';
  const observerKey = parts[parts.length - 2] || '';
  if (!observerKey) {
    return;
  }
  if (streamType === 'packets') {
    handlePacketMessage(topic, observerKey, payload);
    return;
  }
  if (streamType === 'status' || streamType === 'internal') {
    if (handleObserverMetadata(topic, observerKey, payload)) {
      broadcastSnapshot(true);
    }
  }
}

export { app, server };

if (IS_MAIN_MODULE && !DISABLE_RUNTIME) {
  startRuntime();
}
