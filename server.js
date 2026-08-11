import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {
  createHash,
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
  normalizeHex,
  normalizeKey,
  normalizeLogLevel,
  normalizePathHop,
  shortKey,
  shouldDecodeChannel,
} from './lib/mesh-health-core.js';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_DATA_DIR = path.join(APP_DIR, 'data');
const require = createRequire(import.meta.url);
const {
  MeshCorePacketDecoder,
  PayloadType: MeshCorePayloadType,
} = require('@michaelhart/meshcore-decoder');
const APP_VERSION = String(require('./package.json').version || '').trim() || '0.0.0';
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

const MESHCORE_PUBLIC_KEY_HEX_LENGTH = 64;
const MAX_MQTT_PAYLOAD_BYTES = 64 * 1024;

function normalizeObserverKey(value) {
  const normalized = normalizeKey(value);
  return normalized.length === MESHCORE_PUBLIC_KEY_HEX_LENGTH ? normalized : '';
}

function isMqttPayloadWithinLimit(payloadBuffer) {
  return Boolean(payloadBuffer && Number(payloadBuffer.length) <= MAX_MQTT_PAYLOAD_BYTES);
}

function normalizeTrustProxy(value) {
  const raw = String(value || '').trim();
  const normalized = raw.toLowerCase();
  if (['false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  if (['true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (/^\d+$/.test(raw)) {
    return Number(raw);
  }
  return raw;
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

function normalizeSiteUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return '';
    }
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return '';
  }
}

function normalizeDistanceUnit(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return ['km', 'kilometer', 'kilometers'].includes(normalized) ? 'km' : 'mi';
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
  const byteSize = OBSERVER_HASH_DISPLAY_BYTES;
  const displayLength = byteSize * 2;
  if (normalized.length < displayLength) {
    return '';
  }
  return normalized.slice(0, displayLength);
}

function observerPathHop(observerKey, hashSize = 1) {
  const normalized = normalizeKey(observerKey);
  const byteSize = Number(hashSize);
  if (!normalized || !Number.isInteger(byteSize) || byteSize < 1 || byteSize > 3) {
    return '';
  }
  const hopLength = byteSize * 2;
  if (normalized.length < hopLength) {
    return '';
  }
  return normalized.slice(0, hopLength);
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
    const profiles = new Map();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return profiles;
    }
    for (const [rawKey, rawValue] of Object.entries(parsed)) {
      const key = normalizeKey(rawKey);
      if (!key) {
        continue;
      }
      if (typeof rawValue === 'string') {
        const name = String(rawValue || '').trim();
        if (name) {
          profiles.set(key, { name, lat: null, lon: null });
        }
        continue;
      }
      if (!rawValue || typeof rawValue !== 'object' || Array.isArray(rawValue)) {
        continue;
      }
      const name = String(rawValue.name || rawValue.label || '').trim();
      const lat = normalizeCoordinate(rawValue.lat ?? rawValue.latitude ?? null, 'lat');
      const lon = normalizeCoordinate(
        rawValue.lon ?? rawValue.lng ?? rawValue.longitude ?? null,
        'lon',
      );
      const hasValidLocation = lat != null && lon != null && !(lat === 0 && lon === 0);
      if (name || hasValidLocation) {
        profiles.set(key, {
          name: name || '',
          lat: hasValidLocation ? lat : null,
          lon: hasValidLocation ? lon : null,
        });
      }
    }
    return profiles;
  } catch (error) {
    logger.warn(`[config] failed to parse ${resolved}: ${error.message}`);
    return new Map();
  }
}

const LOG_LEVEL = normalizeLogLevel(envValue('LOG_LEVEL', 'info'));
const logger = createLogger(LOG_LEVEL);
const DISABLE_RUNTIME = envBool('MESH_HEALTH_DISABLE_RUNTIME', false);
const DISABLE_OBSERVER_FILE_WRITES = DISABLE_RUNTIME || envBool('DISABLE_OBSERVER_FILE_WRITES', false);
const DISABLE_RESULTS_FILE_WRITES = envBool('DISABLE_RESULTS_FILE_WRITES', false);
const PORT = envNumber('PORT', 3090);
const MQTT_URL = buildMqttUrl();
const MQTT_TOPICS = dedupe(envList('MQTT_TOPIC').length > 0
  ? envList('MQTT_TOPIC')
  : ['meshcore/BOS/#']);
const OBSERVERS_FILE = envValue('OBSERVERS_FILE', path.join('data', 'observer.json'));
const OBSERVERS_FILE_PATH = resolveAppPath(OBSERVERS_FILE);
const OBSERVER_ACTIVITY_FILE = envValue('OBSERVER_ACTIVITY_FILE', path.join('data', 'observer-activity.json'));
const OBSERVER_ACTIVITY_FILE_PATH = resolveAppPath(OBSERVER_ACTIVITY_FILE);
const REGIONS_FILE = envValue('REGIONS_FILE', '');
const REGION_NAME_PROPERTY = envValue('REGION_NAME_PROPERTY', 'name');
const REGION_GROUP_PROPERTY = envValue('REGION_GROUP_PROPERTY', 'group');
const RESULTS_FILE = envValue('RESULTS_FILE', path.join('data', 'session-results.json'));
const RESULTS_FILE_PATH = resolveAppPath(RESULTS_FILE);
const APP_TITLE = envValue('APP_TITLE', 'Mesh Health Check');
const APP_EYEBROW = envValue('APP_EYEBROW', 'MeshCore Observer Coverage');
const APP_HEADLINE = envValue('APP_HEADLINE', 'Check your mesh reach.');
const APP_DESCRIPTION = envValue(
  'APP_DESCRIPTION',
  'Generate a test code, send it to the configured channel, and watch observer coverage build in real time.',
);
const SITE_URL = normalizeSiteUrl(envValue('SITE_URL', ''));
const CORESCOPE_URL = normalizeSiteUrl(envValue('CORESCOPE_URL', ''));
const DISTANCE_UNIT = normalizeDistanceUnit(envValue('DISTANCE_UNIT', 'mi'));
const PWA_APP_NAME = 'Mesh Reach';
const REPO_URL = 'https://github.com/yellowcooln/meshcore-health-check';
const EXTERNAL_LINK_URL = normalizeSiteUrl(envValue('EXTERNAL_LINK_URL', ''));
const EXTERNAL_LINK_LABEL = envValue('EXTERNAL_LINK_LABEL', '');
const DASH_BROKER_HOST = envValue('DASH_BROKER_HOST', '');
const APP_TITLE_OVERRIDE = envValue('APP_TITLE', '');
const TRUST_PROXY = normalizeTrustProxy(envValue('TRUST_PROXY', '1'));
const TURNSTILE_SITE_KEY = envValue('TURNSTILE_SITE_KEY', '');
const TURNSTILE_SECRET_KEY = envValue('TURNSTILE_SECRET_KEY', '');
const TURNSTILE_ENABLED = envBool(
  'TURNSTILE_ENABLED',
  Boolean(TURNSTILE_SITE_KEY && TURNSTILE_SECRET_KEY),
);
if (TURNSTILE_ENABLED && (!TURNSTILE_SITE_KEY || !TURNSTILE_SECRET_KEY)) {
  throw new Error(
    'TURNSTILE_ENABLED=true requires both TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY',
  );
}
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
const TURNSTILE_VERIFY_TIMEOUT_MS = Math.max(
  1000,
  Math.min(30000, envNumber('TURNSTILE_VERIFY_TIMEOUT_MS', 5000)),
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
const OBSERVER_TOP_WINDOW_DAYS = Math.max(
  1,
  Math.round(envNumber('OBSERVER_TOP_WINDOW_DAYS', 7)),
);
const OBSERVER_TOP_COUNT = Math.max(
  1,
  Math.round(envNumber('OBSERVER_TOP_COUNT', 10)),
);
const OBSERVER_HASH_DISPLAY_BYTES = Math.max(
  1,
  Math.min(3, Math.round(envNumber('OBSERVER_HASH_DISPLAY_BYTES', 1))),
);
const OBSERVER_RETENTION_SECONDS = envNumber('OBSERVER_RETENTION_SECONDS', 0);
const OBSERVER_RETENTION_MS = OBSERVER_RETENTION_SECONDS <= 0
  ? 0
  : Math.max(300, OBSERVER_RETENTION_SECONDS) * 1000;
const OBSERVER_ACTIVITY_RETENTION_DAYS = Math.max(
  OBSERVER_TOP_WINDOW_DAYS,
  Math.round(envNumber('OBSERVER_ACTIVITY_RETENTION_DAYS', 30)),
);
const OBSERVER_ACTIVITY_RETENTION_MS = OBSERVER_ACTIVITY_RETENTION_DAYS * 86400000;
const MAX_OBSERVER_ENTRIES = Math.max(
  1,
  Math.round(envNumber('MAX_OBSERVER_ENTRIES', 10000)),
);
const MAX_RATE_LIMIT_BUCKETS = Math.max(
  1,
  Math.round(envNumber('MAX_RATE_LIMIT_BUCKETS', 10000)),
);
const MAX_WS_CONNECTIONS = Math.max(
  1,
  Math.round(envNumber('MAX_WS_CONNECTIONS', 512)),
);
const MAX_WS_BUFFERED_BYTES = Math.max(
  65536,
  Math.round(envNumber('MAX_WS_BUFFERED_BYTES', 1048576)),
);
const WS_HEARTBEAT_INTERVAL_MS = Math.max(
  10000,
  Math.round(envNumber('WS_HEARTBEAT_INTERVAL_MS', 30000)),
);
const SESSION_TTL_MS = Math.max(60, envNumber('SESSION_TTL_SECONDS', 600)) * 1000;
const RESULT_RETENTION_MS = Math.max(
  SESSION_TTL_MS / 1000,
  envNumber('RESULT_RETENTION_SECONDS', 604800),
) * 1000;
const SESSION_HASH_ALIAS_WINDOW_MS = Math.max(
  5,
  envNumber('SESSION_HASH_ALIAS_WINDOW_SECONDS', 90),
) * 1000;
const MAX_USES_PER_CODE = Math.max(1, envNumber('MAX_USES_PER_CODE', 3));
const KNOWN_OBSERVERS = dedupe(envList('KNOWN_OBSERVERS').map(normalizeObserverKey));

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

const meshPacketDecoderKeyStore = envTestChannelSecret
  ? MeshCorePacketDecoder.createKeyStore({
      channelSecrets: [envTestChannelSecret],
    })
  : null;

// ─── Region detection ─────────────────────────────────────────────────────────

function pointInRing(px, py, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function pointInPolygonCoords(lon, lat, rings) {
  if (!pointInRing(lon, lat, rings[0])) return false;
  for (let i = 1; i < rings.length; i++) {
    if (pointInRing(lon, lat, rings[i])) return false; // inside a hole
  }
  return true;
}

function pointInFeature(lon, lat, geometry) {
  if (geometry.type === 'Polygon') {
    return pointInPolygonCoords(lon, lat, geometry.coordinates);
  }
  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.some((poly) => pointInPolygonCoords(lon, lat, poly));
  }
  return false;
}

function expandBounds(bounds, coordinate) {
  if (!Array.isArray(coordinate) || coordinate.length < 2) {
    return bounds;
  }
  const [lon, lat] = coordinate;
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
    return bounds;
  }
  if (!bounds) {
    return [lon, lat, lon, lat];
  }
  bounds[0] = Math.min(bounds[0], lon);
  bounds[1] = Math.min(bounds[1], lat);
  bounds[2] = Math.max(bounds[2], lon);
  bounds[3] = Math.max(bounds[3], lat);
  return bounds;
}

function geometryBounds(geometry) {
  if (!geometry) {
    return null;
  }
  let bounds = null;
  if (geometry.type === 'Polygon') {
    for (const ring of geometry.coordinates || []) {
      for (const coordinate of ring || []) {
        bounds = expandBounds(bounds, coordinate);
      }
    }
  } else if (geometry.type === 'MultiPolygon') {
    for (const polygon of geometry.coordinates || []) {
      for (const ring of polygon || []) {
        for (const coordinate of ring || []) {
          bounds = expandBounds(bounds, coordinate);
        }
      }
    }
  }
  return bounds;
}

function pointInBounds(lon, lat, bounds) {
  return Array.isArray(bounds)
    && lon >= bounds[0]
    && lat >= bounds[1]
    && lon <= bounds[2]
    && lat <= bounds[3];
}

function regionProperty(properties, names = []) {
  for (const name of names) {
    const value = properties?.[name];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

function loadRegionBoundaries() {
  if (!REGIONS_FILE) return [];
  const filePath = resolveAppPath(REGIONS_FILE);
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    logger.warn(`[regions] could not read ${filePath} — region detection disabled`);
    return [];
  }
  let geojson;
  try {
    geojson = JSON.parse(raw);
  } catch {
    logger.warn('[regions] regions file contains invalid JSON — region detection disabled');
    return [];
  }
  if (geojson.type !== 'FeatureCollection' || !Array.isArray(geojson.features)) {
    logger.warn('[regions] regions file is not a GeoJSON FeatureCollection — region detection disabled');
    return [];
  }
  const boundaries = geojson.features.map((feature) => {
    const properties = feature?.properties || {};
    const type = feature?.geometry?.type;
    const name = regionProperty(properties, [
      REGION_NAME_PROPERTY,
      'name',
      'NAME',
      'name_en',
      'NAME_2',
      'NAME_1',
      'region',
      'subregion',
    ]);
    const group = regionProperty(properties, [
      REGION_GROUP_PROPERTY,
      'group',
      'parent',
      'regionGroup',
      'region_group',
    ]);
    return {
      name,
      group,
      geometry: feature?.geometry || null,
      type,
      bounds: geometryBounds(feature?.geometry || null),
    };
  }).filter((entry) => entry.name && (entry.type === 'Polygon' || entry.type === 'MultiPolygon'));
  logger.info(`[regions] loaded ${boundaries.length} region boundaries from ${REGIONS_FILE}`);
  return boundaries;
}

const regionBoundaries = loadRegionBoundaries();

function deriveRegionInfo(lat, lon) {
  if (lat == null || lon == null || regionBoundaries.length === 0) {
    return { region: null, regionGroup: null };
  }
  for (const boundary of regionBoundaries) {
    if (!pointInBounds(lon, lat, boundary.bounds)) {
      continue;
    }
    if (pointInFeature(lon, lat, boundary.geometry)) {
      return {
        region: boundary.name,
        regionGroup: boundary.group || null,
      };
    }
  }
  return { region: null, regionGroup: null };
}

function utcDayKey(timestamp = Date.now()) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function recentUtcDayKeys(days, now = Date.now()) {
  const safeDays = Math.max(1, Math.round(Number(days) || 1));
  const keys = [];
  for (let index = 0; index < safeDays; index += 1) {
    keys.push(utcDayKey(now - (index * 86400000)));
  }
  return keys;
}

// ─────────────────────────────────────────────────────────────────────────────

const observerProfiles = parseObserversJson(OBSERVERS_FILE_PATH);
const pinnedObserverNameKeys = new Set(
  [...observerProfiles.entries()]
    .filter(([, profile]) => String(profile?.name || '').trim())
    .map(([key]) => key),
);
const appHtmlTemplate = fs.readFileSync(path.join(APP_DIR, 'public/index.html'), 'utf8');
const landingHtmlTemplate = fs.readFileSync(path.join(APP_DIR, 'public/landing.html'), 'utf8');
const shareHtmlTemplate = fs.readFileSync(path.join(APP_DIR, 'public/share.html'), 'utf8');
const observerState = new Map();
const observerActivityHistory = parseObserverActivityJson(OBSERVER_ACTIVITY_FILE_PATH);
const sessions = new Map();
const messageToSession = new Map();
const rateLimitBuckets = new Map();
const turnstileAuthTokens = new Map();
let observerNamesWriteTimer = null;
let observerActivityWriteTimer = null;
let resultsWriteTimer = null;
const asyncFileWriteQueues = new Map();

function writeJsonFileAtomic(filePath, payload) {
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  const tempPath = `${filePath}.tmp`;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tempPath, body, 'utf8');
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    if (error?.code === 'EBUSY' || error?.code === 'EXDEV') {
      try {
        fs.writeFileSync(filePath, body, 'utf8');
        try {
          fs.unlinkSync(tempPath);
        } catch {
          // ignore cleanup failure
        }
        return;
      } catch (fallbackError) {
        logger.warn(`[storage] failed to write ${filePath}: ${fallbackError.message}`);
      }
    }
    logger.warn(`[storage] failed to write ${filePath}: ${error.message}`);
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // preserve the last known-good file when cleanup also fails
    }
  }
}

async function writeJsonFileAtomicAsync(filePath, payload) {
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  const tempPath = `${filePath}.tmp`;
  try {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(tempPath, body, 'utf8');
    await fs.promises.rename(tempPath, filePath);
  } catch (error) {
    if (error?.code === 'EBUSY' || error?.code === 'EXDEV') {
      try {
        await fs.promises.writeFile(filePath, body, 'utf8');
        await fs.promises.unlink(tempPath).catch(() => {});
        return;
      } catch (fallbackError) {
        logger.warn(`[storage] failed to write ${filePath}: ${fallbackError.message}`);
      }
    } else {
      logger.warn(`[storage] failed to write ${filePath}: ${error.message}`);
    }
    await fs.promises.unlink(tempPath).catch(() => {});
  }
}

function queueJsonFileWrite(filePath, payload) {
  let queue = asyncFileWriteQueues.get(filePath);
  if (!queue) {
    queue = {
      payload: null,
      running: false,
      promise: Promise.resolve(),
    };
    asyncFileWriteQueues.set(filePath, queue);
  }
  queue.payload = payload;
  if (queue.running) {
    return queue.promise;
  }

  queue.running = true;
  queue.promise = (async () => {
    while (queue.payload !== null) {
      const nextPayload = queue.payload;
      queue.payload = null;
      await writeJsonFileAtomicAsync(filePath, nextPayload);
    }
  })().catch((error) => {
    logger.warn(`[storage] queued write failed for ${filePath}: ${error.message}`);
  }).finally(() => {
    queue.running = false;
    if (queue.payload === null) {
      asyncFileWriteQueues.delete(filePath);
    }
  });
  return queue.promise;
}

function parseObserverActivityJson(filePath) {
  const resolved = resolveAppPath(filePath);
  if (!fs.existsSync(resolved)) {
    return new Map();
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    const rawObservers = parsed?.observers && typeof parsed.observers === 'object'
      ? parsed.observers
      : parsed;
    const history = new Map();
    if (!rawObservers || typeof rawObservers !== 'object' || Array.isArray(rawObservers)) {
      return history;
    }

    for (const [rawKey, rawEntry] of Object.entries(rawObservers)) {
      const key = normalizeKey(rawKey);
      if (!key || !rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
        continue;
      }
      const days = {};
      const rawDays = rawEntry.days && typeof rawEntry.days === 'object' ? rawEntry.days : {};
      for (const [dayKey, rawCount] of Object.entries(rawDays)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) {
          continue;
        }
        const count = Math.max(0, Math.floor(Number(rawCount) || 0));
        if (count > 0) {
          days[dayKey] = count;
        }
      }
      const lastPacketAt = Number(rawEntry.lastPacketAt || 0);
      if (Object.keys(days).length > 0 || (Number.isFinite(lastPacketAt) && lastPacketAt > 0)) {
        history.set(key, {
          days,
          lastPacketAt: Number.isFinite(lastPacketAt) && lastPacketAt > 0 ? lastPacketAt : 0,
        });
      }
    }
    return history;
  } catch (error) {
    logger.warn(`[config] failed to parse ${resolved}: ${error.message}`);
    return new Map();
  }
}

function cloneObserverActivityHistory(source) {
  const out = new Map();
  for (const [key, entry] of source.entries()) {
    out.set(key, {
      days: { ...(entry?.days || {}) },
      lastPacketAt: Number(entry?.lastPacketAt || 0),
    });
  }
  return out;
}

const baselineObserverActivityHistory = cloneObserverActivityHistory(observerActivityHistory);

function sessionRetentionDeadline(session) {
  const createdAt = Number(session?.createdAt || 0);
  return createdAt + RESULT_RETENTION_MS;
}

function isRetainedSession(session, now = Date.now()) {
  if (!session?.id || !Number.isFinite(Number(session.createdAt))) {
    return false;
  }
  return now < sessionRetentionDeadline(session);
}

function serializeSessionRecord(session) {
  return {
    id: session.id,
    code: session.code,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    status: session.status,
    useCount: session.useCount,
    maxUses: session.maxUses,
    messageHash: session.messageHash,
    messageHashes: Array.isArray(session.messageHashes)
      ? session.messageHashes.map(normalizeMessageHash).filter(Boolean)
      : [],
    matchedAt: session.matchedAt,
    messageBody: session.messageBody,
    sender: session.sender,
    channelHash: session.channelHash,
    channelName: session.channelName,
    allowlistEnabled: Boolean(session.allowlistEnabled),
    expectedObserverKeys: Array.isArray(session.expectedObserverKeys)
      ? session.expectedObserverKeys.map(normalizeKey).filter(Boolean)
      : [],
    expectedObserverSource: String(session.expectedObserverSource || ''),
    receipts: [...(session.receipts?.values() || [])].map((receipt) => ({
      observerKey: normalizeKey(receipt.observerKey),
      observerHash: String(receipt.observerHash || '').trim().toUpperCase(),
      observerLabel: String(receipt.observerLabel || '').trim(),
      observerName: String(receipt.observerName || '').trim(),
      firstSeenAt: Number(receipt.firstSeenAt || 0),
      lastSeenAt: Number(receipt.lastSeenAt || 0),
      count: Math.max(1, Number(receipt.count || 1)),
      topic: String(receipt.topic || ''),
      messageHash: normalizeMessageHash(receipt.messageHash),
      packetType: receipt.packetType,
      channelName: String(receipt.channelName || ''),
      rssi: Number.isFinite(Number(receipt.rssi)) ? Number(receipt.rssi) : null,
      snr: Number.isFinite(Number(receipt.snr)) ? Number(receipt.snr) : null,
      duration: Number.isFinite(Number(receipt.duration)) ? Number(receipt.duration) : null,
      path: Array.isArray(receipt.path)
        ? receipt.path.map(normalizePathHop).filter(Boolean)
        : [],
    })).filter((receipt) => receipt.observerKey),
  };
}

function restoreSessionRecord(rawSession) {
  if (!rawSession || typeof rawSession !== 'object' || Array.isArray(rawSession)) {
    return null;
  }
  const id = String(rawSession.id || '').trim();
  const code = String(rawSession.code || '').trim().toUpperCase();
  const createdAt = Number(rawSession.createdAt || 0);
  if (!id || !code || !Number.isFinite(createdAt) || createdAt <= 0) {
    return null;
  }
  const expectedObserverKeys = Array.isArray(rawSession.expectedObserverKeys)
    ? rawSession.expectedObserverKeys.map(normalizeKey).filter(Boolean)
    : [];
  const receipts = new Map();
  for (const rawReceipt of Array.isArray(rawSession.receipts) ? rawSession.receipts : []) {
    const observerKey = normalizeKey(rawReceipt?.observerKey);
    if (!observerKey) {
      continue;
    }
    ensureObserverRecord(observerKey);
    receipts.set(observerKey, {
      observerKey,
      observerHash: String(rawReceipt?.observerHash || '').trim().toUpperCase(),
      observerLabel: String(rawReceipt?.observerLabel || '').trim(),
      observerName: String(rawReceipt?.observerName || '').trim() || null,
      firstSeenAt: Number(rawReceipt?.firstSeenAt || createdAt),
      lastSeenAt: Number(rawReceipt?.lastSeenAt || rawReceipt?.firstSeenAt || createdAt),
      count: Math.max(1, Number(rawReceipt?.count || 1)),
      topic: String(rawReceipt?.topic || ''),
      messageHash: normalizeMessageHash(rawReceipt?.messageHash || rawSession.messageHash || ''),
      packetType: rawReceipt?.packetType ?? null,
      channelName: String(rawReceipt?.channelName || rawSession.channelName || ''),
      rssi: Number.isFinite(Number(rawReceipt?.rssi)) ? Number(rawReceipt.rssi) : null,
      snr: Number.isFinite(Number(rawReceipt?.snr)) ? Number(rawReceipt.snr) : null,
      duration: Number.isFinite(Number(rawReceipt?.duration)) ? Number(rawReceipt.duration) : null,
      path: Array.isArray(rawReceipt?.path)
        ? rawReceipt.path.map(normalizePathHop).filter(Boolean)
        : [],
    });
  }
  for (const observerKey of expectedObserverKeys) {
    ensureObserverRecord(observerKey);
  }
  return {
    id,
    code,
    createdAt,
    expiresAt: Number(rawSession.expiresAt || (createdAt + SESSION_TTL_MS)),
    status: String(rawSession.status || 'waiting'),
    useCount: Math.max(0, Number(rawSession.useCount || 0)),
    maxUses: Math.max(1, Number(rawSession.maxUses || MAX_USES_PER_CODE)),
    messageHash: normalizeMessageHash(rawSession.messageHash || ''),
    messageHashes: dedupe(
      (Array.isArray(rawSession.messageHashes) ? rawSession.messageHashes : [])
        .map(normalizeMessageHash)
        .filter(Boolean),
    ),
    matchedAt: Number(rawSession.matchedAt || 0),
    messageBody: String(rawSession.messageBody || ''),
    sender: String(rawSession.sender || ''),
    channelHash: String(rawSession.channelHash || '').trim().toLowerCase(),
    channelName: String(rawSession.channelName || ''),
    allowlistEnabled: Boolean(rawSession.allowlistEnabled),
    expectedObserverKeys,
    expectedObserverSource: String(rawSession.expectedObserverSource || ''),
    receipts,
  };
}

function resultsFilePayload() {
  return {
    version: 1,
    sessions: [...sessions.values()]
      .filter((session) => isRetainedSession(session))
      .sort((left, right) => left.createdAt - right.createdAt)
      .map(serializeSessionRecord),
  };
}

function writeResultsFile() {
  const payload = resultsFilePayload();
  writeJsonFileAtomic(RESULTS_FILE_PATH, payload);
}

function scheduleResultsWrite() {
  if (DISABLE_RESULTS_FILE_WRITES) {
    return;
  }
  if (resultsWriteTimer) {
    return;
  }
  resultsWriteTimer = setTimeout(() => {
    resultsWriteTimer = null;
    queueJsonFileWrite(RESULTS_FILE_PATH, resultsFilePayload());
  }, 250);
}

function cancelScheduledWriteTimers() {
  if (observerNamesWriteTimer) {
    clearTimeout(observerNamesWriteTimer);
    observerNamesWriteTimer = null;
  }
  if (observerActivityWriteTimer) {
    clearTimeout(observerActivityWriteTimer);
    observerActivityWriteTimer = null;
  }
  if (resultsWriteTimer) {
    clearTimeout(resultsWriteTimer);
    resultsWriteTimer = null;
  }
}

function flushScheduledWrites() {
  cancelScheduledWriteTimers();
  writeObserverNamesFile();
  writeObserverActivityFile();
  if (!DISABLE_RESULTS_FILE_WRITES) {
    writeResultsFile();
  }
}

async function flushScheduledWritesAsync() {
  cancelScheduledWriteTimers();
  const pendingWrites = [...asyncFileWriteQueues.values()].map((queue) => queue.promise);
  await Promise.all(pendingWrites);
  const writes = [];
  if (!DISABLE_OBSERVER_FILE_WRITES) {
    writes.push(
      writeJsonFileAtomicAsync(OBSERVERS_FILE_PATH, observerNamesFilePayload()),
      writeJsonFileAtomicAsync(OBSERVER_ACTIVITY_FILE_PATH, observerActivityFilePayload()),
    );
  }
  if (!DISABLE_RESULTS_FILE_WRITES) {
    writes.push(writeJsonFileAtomicAsync(RESULTS_FILE_PATH, resultsFilePayload()));
  }
  await Promise.all(writes);
}

function observerNamesFilePayload() {
  const payload = {};
  for (const [key, profile] of [...observerProfiles.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (!profile) {
      continue;
    }
    const name = String(profile.name || '').trim();
    const lat = normalizeCoordinate(profile.lat, 'lat');
    const lon = normalizeCoordinate(profile.lon, 'lon');
    payload[key] = {
      ...(name ? { name } : {}),
      ...(lat != null ? { lat } : {}),
      ...(lon != null ? { lon } : {}),
    };
  }
  return payload;
}

function writeObserverNamesFile() {
  const payload = observerNamesFilePayload();
  writeJsonFileAtomic(OBSERVERS_FILE_PATH, payload);
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
    queueJsonFileWrite(OBSERVERS_FILE_PATH, observerNamesFilePayload());
  }, 1000);
}

function observerActivityFilePayload() {
  const observers = {};
  for (const [key, entry] of [...observerActivityHistory.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const days = Object.fromEntries(
      Object.entries(entry?.days || {})
        .filter(([, count]) => Math.max(0, Math.floor(Number(count) || 0)) > 0)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([dayKey, count]) => [dayKey, Math.max(0, Math.floor(Number(count) || 0))]),
    );
    const lastPacketAt = Number(entry?.lastPacketAt || 0);
    if (Object.keys(days).length === 0 && !(Number.isFinite(lastPacketAt) && lastPacketAt > 0)) {
      continue;
    }
    observers[key] = {
      ...(Object.keys(days).length > 0 ? { days } : {}),
      ...(Number.isFinite(lastPacketAt) && lastPacketAt > 0 ? { lastPacketAt } : {}),
    };
  }
  return {
    version: 1,
    observers,
  };
}

function writeObserverActivityFile() {
  writeJsonFileAtomic(OBSERVER_ACTIVITY_FILE_PATH, observerActivityFilePayload());
}

function scheduleObserverActivityWrite() {
  if (observerActivityWriteTimer) {
    return;
  }
  observerActivityWriteTimer = setTimeout(() => {
    observerActivityWriteTimer = null;
    queueJsonFileWrite(OBSERVER_ACTIVITY_FILE_PATH, observerActivityFilePayload());
  }, 1000);
}

if (!fs.existsSync(OBSERVERS_FILE_PATH)) {
  writeObserverNamesFile();
}

if (!fs.existsSync(RESULTS_FILE_PATH) && !DISABLE_RESULTS_FILE_WRITES) {
  writeResultsFile();
}

function createObserverRecord(observerKey) {
  const profile = observerProfiles.get(observerKey) || null;
  const activity = observerActivityHistory.get(observerKey) || null;
  const lat = normalizeCoordinate(profile?.lat ?? null, 'lat');
  const lon = normalizeCoordinate(profile?.lon ?? null, 'lon');
  const regionInfo = deriveRegionInfo(lat, lon);
  const lastPacketAt = Math.max(0, Number(activity?.lastPacketAt || 0));
  return {
    key: observerKey,
    hash: hashFromKeyPrefix(observerKey),
    name: profile?.name || null,
    lat,
    lon,
    region: regionInfo.region,
    regionGroup: regionInfo.regionGroup,
    firstSeenAt: lastPacketAt,
    lastPacketAt,
    packetCount: 0,
  };
}

function normalizeMessageHash(value) {
  const raw = String(value || '').trim().toUpperCase();
  if (!raw) {
    return '';
  }
  const compact = raw.replace(/[^0-9A-F]/g, '');
  return compact || raw;
}

function normalizeCoordinate(value, axis) {
  if (value == null || value === '') {
    return null;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  const limit = axis === 'lat' ? 90 : 180;
  if (Math.abs(numeric) <= limit) {
    return Number(numeric.toFixed(6));
  }
  for (const scale of [1e7, 1e6, 1e5, 1e4]) {
    const scaled = numeric / scale;
    if (Math.abs(scaled) <= limit) {
      return Number(scaled.toFixed(6));
    }
  }
  return null;
}

function extractLocationCandidate(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const lat = normalizeCoordinate(value.lat ?? value.latitude ?? null, 'lat');
  const lon = normalizeCoordinate(value.lon ?? value.lng ?? value.longitude ?? null, 'lon');
  if (lat === 0 && lon === 0) {
    return null;
  }
  if (lat != null && lon != null) {
    return { lat, lon };
  }
  return null;
}

function extractObserverLocation(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const direct = extractLocationCandidate(value);
  if (direct) {
    return direct;
  }
  for (const child of Object.values(value)) {
    if (!child || typeof child !== 'object') {
      continue;
    }
    const found = extractObserverLocation(child);
    if (found) {
      return found;
    }
  }
  return null;
}

function normalizedSender(value) {
  return String(value || '').trim().toLowerCase();
}

function unlinkSessionHashes(session, clearHashes = true) {
  if (!session) {
    return;
  }
  const knownHashes = Array.isArray(session.messageHashes)
    ? session.messageHashes
    : [session.messageHash].filter(Boolean);
  for (const hash of knownHashes) {
    messageToSession.delete(hash);
  }
  if (clearHashes) {
    session.messageHashes = [];
  }
}

function linkSessionHash(session, hash) {
  const normalizedHash = normalizeMessageHash(hash);
  if (!session || !normalizedHash) {
    return;
  }
  const knownHashes = Array.isArray(session.messageHashes) ? session.messageHashes : [];
  if (!knownHashes.includes(normalizedHash)) {
    knownHashes.push(normalizedHash);
  }
  session.messageHashes = knownHashes;
  if (!session.messageHash) {
    session.messageHash = normalizedHash;
  }
  messageToSession.set(normalizedHash, session.id);
}

function isPacketCompatibleWithSession(session, packetInfo) {
  if (!session || !packetInfo) {
    return false;
  }
  const sessionBody = String(session.messageBody || '').trim();
  const packetBody = String(packetInfo.messageBody || '').trim();
  if (!sessionBody || !packetBody || sessionBody !== packetBody) {
    return false;
  }
  const sessionSender = normalizedSender(session.sender);
  const packetSender = normalizedSender(packetInfo.sender);
  if (!sessionSender || !packetSender || sessionSender !== packetSender) {
    return false;
  }
  if (!session.channelHash || !packetInfo.channelHash || session.channelHash !== packetInfo.channelHash) {
    return false;
  }
  return true;
}

function isSameActiveMessageAlias(session, packetInfo) {
  if (!session?.messageHash || !session?.matchedAt) {
    return false;
  }
  if (!packetInfo?.messageHash || !packetInfo?.messageBody) {
    return false;
  }
  if (!isPacketCompatibleWithSession(session, packetInfo)) {
    return false;
  }
  if (packetInfo.messageHash === session.messageHash) {
    return true;
  }
  if (packetInfo.seenAt - session.matchedAt > SESSION_HASH_ALIAS_WINDOW_MS) {
    return false;
  }
  if (session.receipts?.size <= 0) {
    return false;
  }
  return true;
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
  const profile = observerProfiles.get(normalizedKey) || null;
  if (!observer.name && profile?.name) {
    observer.name = profile.name;
  }
  if (observer.lat == null && profile?.lat != null) {
    observer.lat = normalizeCoordinate(profile.lat, 'lat');
  }
  if (observer.lon == null && profile?.lon != null) {
    observer.lon = normalizeCoordinate(profile.lon, 'lon');
  }
  return observer;
}

function primeObserverDirectory() {
  for (const key of observerProfiles.keys()) {
    ensureObserverRecord(key);
  }
  for (const key of observerActivityHistory.keys()) {
    ensureObserverRecord(key);
  }
  for (const key of KNOWN_OBSERVERS) {
    ensureObserverRecord(key);
  }
}

primeObserverDirectory();

function loadRetainedSessions() {
  const parsed = readStructuredFile(RESULTS_FILE_PATH);
  const rawSessions = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.sessions)
      ? parsed.sessions
      : [];
  const now = Date.now();
  let dropped = false;
  for (const rawSession of rawSessions) {
    const session = restoreSessionRecord(rawSession);
    if (!session) {
      dropped = true;
      continue;
    }
    if (!isRetainedSession(session, now)) {
      dropped = true;
      continue;
    }
    if (session.status !== 'expired' && now >= session.expiresAt) {
      session.status = 'expired';
    }
    sessions.set(session.id, session);
    for (const hash of session.messageHashes) {
      if (session.status !== 'expired') {
        messageToSession.set(hash, session.id);
      }
    }
  }
  if (dropped) {
    scheduleResultsWrite();
  }
}

loadRetainedSessions();

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
  if (SITE_URL) {
    return SITE_URL;
  }
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

function pruneRateLimitBuckets(now = Date.now()) {
  let removed = false;
  for (const [key, bucket] of rateLimitBuckets.entries()) {
    if (!bucket || bucket.resetAt <= now) {
      rateLimitBuckets.delete(key);
      removed = true;
    }
  }

  if (rateLimitBuckets.size > MAX_RATE_LIMIT_BUCKETS) {
    const overflow = rateLimitBuckets.size - MAX_RATE_LIMIT_BUCKETS;
    const oldest = [...rateLimitBuckets.entries()]
      .sort(([, left], [, right]) => left.resetAt - right.resetAt)
      .slice(0, overflow);
    for (const [key] of oldest) {
      rateLimitBuckets.delete(key);
      removed = true;
    }
  }
  return removed;
}

function rateLimit(namespace, maxRequests, windowMs) {
  return (request, response, next) => {
    const key = `${namespace}:${clientAddress(request)}`;
    const now = Date.now();
    pruneRateLimitBuckets(now);
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
      signal: AbortSignal.timeout(TURNSTILE_VERIFY_TIMEOUT_MS),
    });
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    if (!response.ok || !contentType.includes('application/json')) {
      logger.warn(
        `[turnstile] verification endpoint returned ${response.status} ${contentType || 'unknown content type'}`,
      );
      return { success: false, error: 'verification_unavailable' };
    }

    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      logger.warn(`[turnstile] verification response was not valid JSON: ${error.message}`);
      return { success: false, error: 'verification_unavailable' };
    }
    if (!payload || typeof payload.success !== 'boolean') {
      logger.warn('[turnstile] verification response did not match the expected schema');
      return { success: false, error: 'verification_unavailable' };
    }
    if (payload.success) {
      return { success: true, error: '' };
    }
    return { success: false, error: 'verification_failed' };
  } catch (error) {
    logger.warn(`[turnstile] verification request failed: ${String(error?.name || error?.message || 'request error').slice(0, 120)}`);
    return { success: false, error: 'verification_unavailable' };
  }
}

function parseEnvelope(payloadBuffer) {
  if (!isMqttPayloadWithinLimit(payloadBuffer)) {
    return { raw: '', envelope: null };
  }
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
  if (!isMqttPayloadWithinLimit(payloadBuffer)) {
    return null;
  }
  const text = payloadBuffer.toString('utf8').trim();
  if (!text.startsWith('{') || !text.endsWith('}')) {
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function extractDeviceName(obj, topic = '') {
  if (!obj || typeof obj !== 'object') {
    return '';
  }

  for (const key of [
    'display_name',
    'displayName',
    'node_name',
    'nodeName',
    'device_name',
    'deviceName',
    'callsign',
    'label',
    'name',
  ]) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  if (String(topic || '').endsWith('/status')) {
    const origin = obj.origin;
    if (typeof origin === 'string' && origin.trim()) {
      return origin.trim();
    }
  }

  return '';
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
  const existingCodes = new Set(
    [...sessions.values()]
      .filter((session) => isRetainedSession(session))
      .map((session) => session.code),
  );
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const candidate = `MHC-${randomBytes(3).toString('hex').toUpperCase()}`;
    if (!existingCodes.has(candidate)) {
      return candidate;
    }
  }
  return `MHC-${randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`;
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

function observerDisplayLabelForKey(observerKey) {
  const observer = observerState.get(observerKey);
  const profile = observerProfiles.get(observerKey);
  return String(observer?.name || profile?.name || shortKey(observerKey));
}

function topObserverKeys(now = Date.now()) {
  const dayKeys = new Set(recentUtcDayKeys(OBSERVER_TOP_WINDOW_DAYS, now));
  const ranked = [];

  for (const [key, entry] of observerActivityHistory.entries()) {
    const lastPacketAt = Math.max(0, Number(entry?.lastPacketAt || 0));
    if (OBSERVER_RETENTION_MS > 0 && (!lastPacketAt || now - lastPacketAt > OBSERVER_RETENTION_MS)) {
      continue;
    }
    let total = 0;
    for (const dayKey of dayKeys) {
      total += Math.max(0, Math.floor(Number(entry?.days?.[dayKey] || 0)));
    }
    if (total <= 0) {
      continue;
    }
    ranked.push({
      key,
      total,
      lastPacketAt,
      label: observerDisplayLabelForKey(key),
    });
  }

  ranked.sort((left, right) => {
    if (left.total !== right.total) {
      return right.total - left.total;
    }
    if (left.lastPacketAt !== right.lastPacketAt) {
      return right.lastPacketAt - left.lastPacketAt;
    }
    const byLabel = left.label.localeCompare(right.label);
    if (byLabel !== 0) {
      return byLabel;
    }
    return left.key.localeCompare(right.key);
  });

  return ranked.slice(0, OBSERVER_TOP_COUNT).map((entry) => entry.key);
}

function defaultObserverTarget(now = Date.now()) {
  if (KNOWN_OBSERVERS.length > 0) {
    return {
      keys: [...KNOWN_OBSERVERS],
      source: 'configured',
    };
  }
  const topKeys = topObserverKeys(now);
  if (topKeys.length > 0) {
    return {
      keys: topKeys,
      source: 'top-window',
    };
  }
  return {
    keys: activeObserverKeys(now),
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
    lat: observer.lat ?? null,
    lon: observer.lon ?? null,
    hasLocation: observer.lat != null && observer.lon != null,
    region: observer.region ?? null,
    regionGroup: observer.regionGroup ?? null,
    shortKey: shortKey(observer.key),
    packetCount: observer.packetCount,
    firstSeenAt: observer.firstSeenAt,
    lastPacketAt: observer.lastPacketAt,
    isRetained: observerIsRetained(observer),
    isActive: Date.now() - observer.lastPacketAt <= OBSERVER_ACTIVE_WINDOW_MS,
  };
}

function observerIsRetained(observer, now = Date.now()) {
  if (!observer?.lastPacketAt) {
    return false;
  }
  if (OBSERVER_RETENTION_MS <= 0) {
    return true;
  }
  return now - observer.lastPacketAt <= OBSERVER_RETENTION_MS;
}

function serializeObserverForKey(observerKey) {
  const observer = ensureObserverRecord(observerKey);
  if (!observer) {
    return {
      key: observerKey,
      hash: hashFromKeyPrefix(observerKey),
      label: shortKey(observerKey),
      name: null,
      lat: null,
      lon: null,
      hasLocation: false,
      region: null,
      regionGroup: null,
      shortKey: shortKey(observerKey),
      packetCount: 0,
      firstSeenAt: 0,
      lastPacketAt: 0,
      isRetained: false,
      isActive: false,
    };
  }
  return serializeObserver(observer);
}

function observerDirectory() {
  const now = Date.now();
  const defaultKeys = new Set(defaultObserverTarget().keys);
  return [...observerState.values()]
    .filter((observer) => observerIsRetained(observer, now))
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

function buildRegionHierarchy(directory) {
  const groups = new Map();
  const ungrouped = new Map();

  for (const observer of directory) {
    if (!observer.region) {
      continue;
    }
    const count = Number.isInteger(observer.packetCount) ? observer.packetCount : 0;
    if (observer.regionGroup) {
      if (!groups.has(observer.regionGroup)) {
        groups.set(observer.regionGroup, {
          group: observer.regionGroup,
          count: 0,
          regions: new Map(),
        });
      }
      const group = groups.get(observer.regionGroup);
      group.count += 1;
      const region = group.regions.get(observer.region) || {
        name: observer.region,
        count: 0,
        packetCount: 0,
      };
      region.count += 1;
      region.packetCount += count;
      group.regions.set(observer.region, region);
    } else {
      const region = ungrouped.get(observer.region) || {
        name: observer.region,
        count: 0,
        packetCount: 0,
      };
      region.count += 1;
      region.packetCount += count;
      ungrouped.set(observer.region, region);
    }
  }

  const byName = (left, right) => String(left.name || left.group).localeCompare(String(right.name || right.group));
  const out = [...groups.values()]
    .map((group) => ({
      group: group.group,
      count: group.count,
      regions: [...group.regions.values()].sort(byName),
    }))
    .sort(byName);

  if (ungrouped.size > 0) {
    out.push({
      group: '',
      count: [...ungrouped.values()].reduce((sum, region) => sum + region.count, 0),
      regions: [...ungrouped.values()].sort(byName),
    });
  }

  return out;
}

function sharePathForSession(session) {
  return `/share/${encodeURIComponent(session.id)}`;
}

function shareUrlForSession(session, request = null) {
  const sharePath = sharePathForSession(session);
  if (!request) {
    return sharePath;
  }
  return `${requestOrigin(request)}${sharePath}`;
}

function observerDisplayLabel(observer, fallbackKey = '') {
  return observer?.name || (fallbackKey ? shortKey(fallbackKey) : '');
}

function observerForPathHop(hop, terminalObserverKey = '') {
  const normalizedHop = normalizePathHop(hop);
  if (!normalizedHop) {
    return null;
  }
  const terminalKey = normalizeKey(terminalObserverKey);
  if (terminalKey && terminalKey.startsWith(normalizedHop)) {
    return observerState.get(terminalKey) || null;
  }
  const matches = [...observerState.values()]
    .filter((observer) => observer?.key?.startsWith(normalizedHop));
  return matches.length === 1 ? matches[0] : null;
}

function distanceKmBetween(left, right) {
  if (
    left?.lat == null || left?.lon == null ||
    right?.lat == null || right?.lon == null
  ) {
    return null;
  }
  const earthRadiusKm = 6371.0088;
  const toRadians = (value) => (Number(value) * Math.PI) / 180;
  const leftLat = toRadians(left.lat);
  const rightLat = toRadians(right.lat);
  const latDelta = toRadians(Number(right.lat) - Number(left.lat));
  const lonDelta = toRadians(Number(right.lon) - Number(left.lon));
  const a = Math.sin(latDelta / 2) ** 2
    + Math.cos(leftLat) * Math.cos(rightLat) * Math.sin(lonDelta / 2) ** 2;
  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function convertDistance(km) {
  if (!Number.isFinite(km)) {
    return null;
  }
  return DISTANCE_UNIT === 'km' ? km : km * 0.621371;
}

function formatDistance(value) {
  if (!Number.isFinite(value)) {
    return '';
  }
  const rounded = value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
  return `${rounded.toLocaleString('en-US')} ${DISTANCE_UNIT}`;
}

function receiptDistanceEstimate(report) {
  const path = Array.isArray(report?.path)
    ? report.path.map(normalizePathHop).filter(Boolean)
    : [];
  const resolved = path
    .map((hop, index) => ({
      hop,
      index,
      observer: observerForPathHop(hop, report.observerKey),
      hasLocation: false,
    }))
    .map((entry) => ({
      ...entry,
      hasLocation: entry.observer?.lat != null && entry.observer?.lon != null,
    }));
  const located = resolved.filter((entry) => entry.hasLocation);
  const segments = [];
  for (let index = 1; index < located.length; index += 1) {
    const from = located[index - 1];
    const to = located[index];
    if (from.observer.key === to.observer.key) {
      continue;
    }
    const km = distanceKmBetween(from.observer, to.observer);
    const distance = convertDistance(km);
    if (!Number.isFinite(distance)) {
      continue;
    }
    segments.push({
      fromHash: from.hop,
      toHash: to.hop,
      fromLabel: observerDisplayLabel(from.observer, from.observer.key),
      toLabel: observerDisplayLabel(to.observer, to.observer.key),
      skippedHopCount: Math.max(0, to.index - from.index - 1),
      estimated: to.index - from.index > 1,
      distance,
      distanceText: formatDistance(distance),
    });
  }
  const distance = segments.reduce((sum, segment) => sum + segment.distance, 0);
  return {
    distance: segments.length > 0 ? distance : null,
    distanceText: segments.length > 0 ? formatDistance(distance) : '',
    segments,
    locatedHopCount: located.length,
    estimatedSegmentCount: segments.filter((segment) => segment.estimated).length,
  };
}

function observerSpanDistanceEstimate(reports) {
  const locatedReceipts = reports
    .map((report) => {
      const observer = observerState.get(report.observerKey);
      return observer?.lat != null && observer?.lon != null
        ? { report, observer }
        : null;
    })
    .filter(Boolean);
  let best = null;
  for (let leftIndex = 0; leftIndex < locatedReceipts.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < locatedReceipts.length; rightIndex += 1) {
      const left = locatedReceipts[leftIndex];
      const right = locatedReceipts[rightIndex];
      const distance = convertDistance(distanceKmBetween(left.observer, right.observer));
      if (!Number.isFinite(distance) || distance <= 0) {
        continue;
      }
      if (!best || distance > best.distance) {
        best = {
          distance,
          distanceText: formatDistance(distance),
          fromLabel: observerDisplayLabel(left.observer, left.report.observerKey),
          toLabel: observerDisplayLabel(right.observer, right.report.observerKey),
        };
      }
    }
  }
  return best;
}

function receiptObserverSpanDistanceEstimate(report, reports) {
  const sourceObserver = observerState.get(report?.observerKey);
  if (sourceObserver?.lat == null || sourceObserver?.lon == null) {
    return null;
  }
  let best = null;
  for (const otherReport of reports) {
    if (otherReport.observerKey === report.observerKey) {
      continue;
    }
    const otherObserver = observerState.get(otherReport.observerKey);
    if (otherObserver?.lat == null || otherObserver?.lon == null) {
      continue;
    }
    const distance = convertDistance(distanceKmBetween(sourceObserver, otherObserver));
    if (!Number.isFinite(distance) || distance <= 0) {
      continue;
    }
    if (!best || distance > best.distance) {
      best = {
        distance,
        distanceText: formatDistance(distance),
        toLabel: observerDisplayLabel(otherObserver, otherReport.observerKey),
      };
    }
  }
  return best;
}

function serializeSession(session, request = null) {
  const allReports = [...session.receipts.values()]
    .sort((left, right) => left.firstSeenAt - right.firstSeenAt)
    .map((report) => {
      const observer = observerState.get(report.observerKey);
      const distanceEstimate = receiptDistanceEstimate(report);
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
        pathDistance: distanceEstimate.distance,
        pathDistanceText: distanceEstimate.distanceText,
        pathDistanceSegments: distanceEstimate.segments,
        pathLocatedHopCount: distanceEstimate.locatedHopCount,
      };
    });

  const expected = dedupe((session.expectedObserverKeys || []).map(normalizeKey));
  const reports = session.allowlistEnabled && expected.length > 0
    ? allReports.filter((report) => expected.includes(normalizeKey(report.observerKey)))
    : allReports;
  for (const report of reports) {
    if (report.pathDistance != null && Number.isFinite(Number(report.pathDistance))) {
      report.displayDistance = report.pathDistance;
      report.displayDistanceText = report.pathDistanceText;
      report.displayDistanceSource = 'path';
      continue;
    }
    const observerSpan = receiptObserverSpanDistanceEstimate(report, reports);
    if (observerSpan) {
      report.displayDistance = observerSpan.distance;
      report.displayDistanceText = observerSpan.distanceText;
      report.displayDistanceSource = 'observer-span';
      report.displayDistanceLabel = `farthest observer: ${observerSpan.toLabel}`;
    } else {
      report.displayDistance = null;
      report.displayDistanceText = '';
      report.displayDistanceSource = '';
      report.displayDistanceLabel = '';
    }
  }
  const seen = dedupe(reports.map((report) => normalizeKey(report.observerKey)));
  const repeaters = dedupe(
    reports.flatMap((report) =>
      Array.isArray(report.path)
        ? report.path
          .slice(0, Math.max(0, report.path.length - 1))
          .map(normalizePathHop)
          .filter(Boolean)
        : []
    ),
  );
  const denominator = Math.max(1, expected.length, seen.length);
  const percent = Math.round((seen.length / denominator) * 100);
  const longestPacketDistance = reports
    .map((report) => Number(report.pathDistance))
    .filter((value) => Number.isFinite(value))
    .reduce((max, value) => Math.max(max, value), 0);
  const observerSpanDistance = longestPacketDistance > 0
    ? null
    : observerSpanDistanceEstimate(reports);
  const bestDistance = longestPacketDistance > 0
    ? longestPacketDistance
    : Number(observerSpanDistance?.distance || 0);

  return {
    id: session.id,
    code: session.code,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    resultExpiresAt: sessionRetentionDeadline(session),
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
    repeaterCount: repeaters.length,
    distanceUnit: DISTANCE_UNIT,
    longestPacketDistance: bestDistance > 0 ? bestDistance : null,
    longestPacketDistanceText: bestDistance > 0 ? formatDistance(bestDistance) : '',
    longestPacketDistanceSource: longestPacketDistance > 0
      ? 'path'
      : (observerSpanDistance ? 'observer-span' : ''),
    longestPacketDistancePair: observerSpanDistance
      ? {
          fromLabel: observerSpanDistance.fromLabel,
          toLabel: observerSpanDistance.toLabel,
        }
      : null,
    expectedCount: denominator,
    healthPercent: percent,
    healthLabel: healthLabel(percent),
    expectedObserverSource: session.expectedObserverSource,
    sharePath: sharePathForSession(session),
    shareUrl: shareUrlForSession(session, request),
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
  const defaultObservers = defaultTarget.keys.map((key) => serializeObserverForKey(key));
  const dashboardBrokerHost = DASH_BROKER_HOST || brokerLabel(MQTT_URL);
  const regionHierarchy = buildRegionHierarchy(directory);

  return {
    serverTime: Date.now(),
    site: {
      title: APP_TITLE,
      version: APP_VERSION,
      eyebrow: APP_EYEBROW,
      headline: APP_HEADLINE,
      description: APP_DESCRIPTION,
      repoUrl: REPO_URL,
      changesUrl: `${REPO_URL}/blob/main/CHANGES.md`,
      coreScopeUrl: CORESCOPE_URL,
      externalLinkUrl: EXTERNAL_LINK_URL,
      externalLinkLabel: EXTERNAL_LINK_LABEL,
    },
    mqtt: {
      connected: mqttConnected,
      broker: dashboardBrokerHost,
      topics: MQTT_TOPICS,
    },
    turnstile: {
      enabled: TURNSTILE_ENABLED,
      siteKey: TURNSTILE_ENABLED ? TURNSTILE_SITE_KEY : '',
    },
    observerStats: {
      configuredCount: KNOWN_OBSERVERS.length,
      retentionSeconds: Math.round(OBSERVER_RETENTION_MS / 1000),
      activeCount: activeObservers.length,
      windowSeconds: Math.round(OBSERVER_ACTIVE_WINDOW_MS / 1000),
      topWindowDays: OBSERVER_TOP_WINDOW_DAYS,
      topCount: OBSERVER_TOP_COUNT,
      hashDisplayBytes: OBSERVER_HASH_DISPLAY_BYTES,
      distanceUnit: DISTANCE_UNIT,
    },
    results: {
      retentionSeconds: Math.round(RESULT_RETENTION_MS / 1000),
    },
    defaultObserverKeys: defaultTarget.keys,
    defaultObservers,
    defaultObserverSource: defaultTarget.source,
    observerDirectory: directory,
    activeObservers,
    regionHierarchy,
    availableRegions: [...new Set(directory.map((o) => o.region).filter(Boolean))].sort(),
    availableRegionGroups: regionHierarchy.map((entry) => entry.group).filter(Boolean),
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

function noteObserverPacketActivity(observerKey, timestamp = Date.now()) {
  const normalizedKey = normalizeKey(observerKey);
  const normalizedTimestamp = Number(timestamp);
  if (!normalizedKey || !Number.isFinite(normalizedTimestamp) || normalizedTimestamp <= 0) {
    return false;
  }
  const dayKey = utcDayKey(normalizedTimestamp);
  const entry = observerActivityHistory.get(normalizedKey) || {
    days: {},
    lastPacketAt: 0,
  };
  const nextCount = Math.max(0, Math.floor(Number(entry.days?.[dayKey] || 0))) + 1;
  const nextLastPacketAt = Math.max(Number(entry.lastPacketAt || 0), normalizedTimestamp);
  const changed = Number(entry.days?.[dayKey] || 0) !== nextCount
    || Number(entry.lastPacketAt || 0) !== nextLastPacketAt;
  entry.days = {
    ...(entry.days || {}),
    [dayKey]: nextCount,
  };
  entry.lastPacketAt = nextLastPacketAt;
  observerActivityHistory.set(normalizedKey, entry);
  if (changed) {
    scheduleObserverActivityWrite();
  }
  return changed;
}

function updateObserverName(observerKey, name, options = {}) {
  const normalizedKey = normalizeKey(observerKey);
  const cleanName = String(name || '').trim();
  if (!normalizedKey || !cleanName) {
    return false;
  }
  const profile = observerProfiles.get(normalizedKey) || { name: '', lat: null, lon: null };
  const previous = String(profile.name || '').trim();
  const observer = ensureObserverRecord(normalizedKey);
  if (!observer) {
    return false;
  }
  if (
    pinnedObserverNameKeys.has(normalizedKey) &&
    previous &&
    previous !== cleanName &&
    !options.allowPinnedOverride
  ) {
    observer.name = previous;
    return false;
  }
  const changed = previous !== cleanName || observer.name !== cleanName;
  observerProfiles.set(normalizedKey, { ...profile, name: cleanName });
  observer.name = cleanName;
  if (changed) {
    logger.debug(`[observer] name ${normalizedKey} -> ${cleanName}`);
    scheduleObserverNamesWrite();
  }
  return changed;
}

function updateObserverLocation(observerKey, location) {
  const normalizedKey = normalizeKey(observerKey);
  const lat = normalizeCoordinate(location?.lat ?? null, 'lat');
  const lon = normalizeCoordinate(location?.lon ?? null, 'lon');
  if (!normalizedKey || lat == null || lon == null || (lat === 0 && lon === 0)) {
    return false;
  }
  const observer = ensureObserverRecord(normalizedKey);
  if (!observer) {
    return false;
  }
  const profile = observerProfiles.get(normalizedKey) || { name: '', lat: null, lon: null };
  const changed = profile.lat !== lat || profile.lon !== lon || observer.lat !== lat || observer.lon !== lon;
  observerProfiles.set(normalizedKey, { ...profile, lat, lon });
  observer.lat = lat;
  observer.lon = lon;
  const regionInfo = deriveRegionInfo(lat, lon);
  observer.region = regionInfo.region;
  observer.regionGroup = regionInfo.regionGroup;
  if (changed) {
    logger.debug(`[observer] location ${normalizedKey} -> ${lat}, ${lon}`);
    scheduleObserverNamesWrite();
  }
  return changed;
}

function handleObserverMetadata(topic, observerKey, payloadBuffer) {
  const normalizedObserverKey = normalizeObserverKey(observerKey);
  if (!normalizedObserverKey || !isMqttPayloadWithinLimit(payloadBuffer)) {
    return false;
  }

  const parsed = parseJsonObject(payloadBuffer);
  if (!parsed) {
    return false;
  }

  const metadataFields = [
    'name', 'label', 'origin', 'origin_id', 'originId', 'publicKey', 'public_key',
    'location', 'lat', 'lon', 'latitude', 'longitude',
  ];
  if (!metadataFields.some((field) => Object.prototype.hasOwnProperty.call(parsed, field))) {
    return false;
  }
  const rawMetadataObserverKey = String(
    parsed.origin_id || parsed.originId || parsed.publicKey || parsed.public_key || '',
  ).trim();
  const metadataObserverKey = normalizeObserverKey(rawMetadataObserverKey);
  if (rawMetadataObserverKey && !metadataObserverKey) {
    return false;
  }
  if (metadataObserverKey && metadataObserverKey !== normalizedObserverKey) {
    return false;
  }

  const observer = touchObserver(normalizedObserverKey);
  if (!observer) {
    return false;
  }

  let changed = false;
  const extractedName = extractDeviceName(parsed, topic);
  if (extractedName) {
    changed = updateObserverName(observer.key, extractedName) || changed;
  }
  changed = updateObserverLocation(observer.key, extractObserverLocation(parsed)) || changed;

  return changed;
}

function matchSessionByCode(messageText, packetInfo = null) {
  const body = String(messageText || '').trim();
  if (!body) {
    return null;
  }
  const now = Date.now();
  const availableSessions = [...sessions.values()]
    .filter((session) =>
      session.status !== 'expired' &&
      now < session.expiresAt &&
      (session.useCount < session.maxUses || isSameActiveMessageAlias(session, packetInfo))
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
    const mappedSession = sessions.get(mappedSessionId);
    return mappedSession && isPacketCompatibleWithSession(mappedSession, packetInfo)
      ? mappedSession
      : null;
  }
  const session = matchSessionByCode(packetInfo.messageBody, packetInfo);
  if (!session) {
    return null;
  }
  if (isSameActiveMessageAlias(session, packetInfo)) {
    linkSessionHash(session, packetInfo.messageHash);
    return session;
  }
  const isNewUse = session.messageHash !== packetInfo.messageHash;
  if (isNewUse) {
    unlinkSessionHashes(session);
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
  linkSessionHash(session, packetInfo.messageHash);
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

function isPinnedObserver(observerKey) {
  return KNOWN_OBSERVERS.includes(observerKey);
}

function pruneObserverState(now = Date.now()) {
  let changed = false;
  const activityCutoff = now - OBSERVER_ACTIVITY_RETENTION_MS;

  for (const [key, entry] of [...observerActivityHistory.entries()]) {
    const days = { ...(entry?.days || {}) };
    for (const dayKey of Object.keys(days)) {
      const dayTimestamp = Date.parse(`${dayKey}T00:00:00Z`);
      if (Number.isFinite(dayTimestamp) && dayTimestamp < activityCutoff) {
        delete days[dayKey];
        changed = true;
      }
    }
    const lastPacketAt = Number(entry?.lastPacketAt || 0);
    if (
      !isPinnedObserver(key)
      && Object.keys(days).length === 0
      && (!lastPacketAt || lastPacketAt < activityCutoff)
    ) {
      observerActivityHistory.delete(key);
      changed = true;
      continue;
    }
    if (Object.keys(days).length !== Object.keys(entry?.days || {}).length) {
      observerActivityHistory.set(key, { days, lastPacketAt });
    }
  }

  if (OBSERVER_RETENTION_MS > 0) {
    for (const [key, observer] of [...observerState.entries()]) {
      if (
        !isPinnedObserver(key)
        && (!observer?.lastPacketAt || now - observer.lastPacketAt > OBSERVER_RETENTION_MS)
      ) {
        observerState.delete(key);
        changed = true;
      }
    }
  }

  const evictOldest = (collection, lastSeen) => {
    if (collection.size <= MAX_OBSERVER_ENTRIES) {
      return false;
    }
    const candidates = [...collection.entries()]
      .filter(([key]) => !isPinnedObserver(key))
      .sort(([leftKey, left], [rightKey, right]) => {
        const leftTime = Number(lastSeen(leftKey, left) || 0);
        const rightTime = Number(lastSeen(rightKey, right) || 0);
        return leftTime - rightTime || leftKey.localeCompare(rightKey);
      });
    let evicted = false;
    for (const [key] of candidates) {
      if (collection.size <= MAX_OBSERVER_ENTRIES) {
        break;
      }
      collection.delete(key);
      evicted = true;
    }
    return evicted;
  };

  if (evictOldest(
    observerState,
    (key, observer) => Math.max(observer?.lastPacketAt || 0, observerActivityHistory.get(key)?.lastPacketAt || 0),
  )) {
    changed = true;
  }
  if (evictOldest(
    observerProfiles,
    (key) => observerActivityHistory.get(key)?.lastPacketAt || observerState.get(key)?.lastPacketAt || 0,
  )) {
    changed = true;
    scheduleObserverNamesWrite();
  }
  if (evictOldest(
    observerActivityHistory,
    (_key, entry) => entry?.lastPacketAt || 0,
  )) {
    changed = true;
  }

  if (changed) {
    scheduleObserverActivityWrite();
  }
  return changed;
}

function pruneState() {
  const now = Date.now();
  let changed = pruneRateLimitBuckets(now);
  changed = pruneObserverState(now) || changed;

  cleanupExpiredTurnstileTokens();

  for (const session of sessions.values()) {
    if (session.status !== 'expired' && now >= session.expiresAt) {
      session.status = 'expired';
      unlinkSessionHashes(session, false);
      changed = true;
    }
  }

  for (const [sessionId, session] of [...sessions.entries()]) {
    if (!isRetainedSession(session, now)) {
      sessions.delete(sessionId);
      unlinkSessionHashes(session);
      changed = true;
    }
  }

  if (changed) {
    scheduleResultsWrite();
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
  const normalizedObserverKey = normalizeObserverKey(observerKey);
  if (!normalizedObserverKey || !isMqttPayloadWithinLimit(payloadBuffer)) {
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
        `[mqtt] packet parse failed on ${shortKey(normalizedObserverKey)}: ${packet.errors.join('; ')}`,
      );
    }
    return;
  }

  const decodedPayload = packet.payload?.decoded && typeof packet.payload.decoded === 'object'
    ? packet.payload.decoded
    : null;
  const decodedPayloadObserverKey = normalizeObserverKey(decodedPayload?.publicKey || '');
  const shouldLearnPacketMetadata = Boolean(decodedPayloadObserverKey);
  let metadataChanged = false;
  const decodedAppData = shouldLearnPacketMetadata
    && decodedPayload?.appData
    && typeof decodedPayload.appData === 'object'
    ? decodedPayload.appData
    : null;
  for (const metadataSource of shouldLearnPacketMetadata ? [decodedAppData, decodedPayload] : []) {
    if (!metadataSource) {
      continue;
    }
    const extractedName = extractDeviceName(metadataSource, topic);
    if (extractedName) {
      metadataChanged = updateObserverName(
        decodedPayloadObserverKey,
        extractedName,
        { allowPinnedOverride: true },
      ) || metadataChanged;
    }
    metadataChanged = updateObserverLocation(
      decodedPayloadObserverKey,
      extractObserverLocation(metadataSource),
    ) || metadataChanged;
  }
  if (metadataChanged) {
    broadcastSnapshot();
  }

  if (packet.payloadType !== MeshCorePayloadType.GroupText || !packet.payload?.decoded) {
    return;
  }
  const groupPayload = packet.payload.decoded;
  if (!shouldDecodeChannel(testChannelHash, groupPayload.channelHash)) {
    logger.debug(
      `[mqtt] ignore channel ${groupPayload.channelHash || 'unknown'} on ${shortKey(normalizedObserverKey)}`,
    );
    return;
  }
  if (!groupPayload.decrypted) {
    logger.debug(
      `[mqtt] target channel packet failed authenticated decode on ${shortKey(normalizedObserverKey)}`,
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
  const messageHash = normalizeMessageHash(packet.messageHash || '');
  const envelopeHash = normalizeMessageHash(
    envelope?.hash || envelope?.message_hash || envelope?.messageHash || '',
  );
  if (!messageHash || (envelopeHash && envelopeHash !== messageHash)) {
    logger.debug(
      `[mqtt] packet hash mismatch on ${shortKey(normalizedObserverKey)} (${envelopeHash || 'missing wrapper hash'} != ${messageHash || 'missing decoded hash'})`,
    );
    return;
  }

  if (!messageBody || !sender) {
    return;
  }

  const observer = touchObserver(normalizedObserverKey);
  if (!observer) {
    return;
  }
  noteObserverPacketActivity(observer.key);

  const path = Array.isArray(packet.path)
    ? packet.path.map((value) => normalizePathHop(value)).filter(Boolean)
    : [];
  const terminalObserverHop = observerPathHop(observer.key, packet.pathHashSize || 1);
  if (terminalObserverHop && path[path.length - 1] !== terminalObserverHop) {
    path.push(terminalObserverHop);
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

  if (isTestChannel && messageBody && sender) {
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
    scheduleResultsWrite();
    broadcastSessionUpdate(session.id);
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
  if (request.path.startsWith('/api/') || request.path.startsWith('/share/')) {
    response.setHeader('Cache-Control', 'no-store');
  }
  response.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "base-uri 'self'",
      "connect-src 'self' ws: wss:",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "frame-src https://challenges.cloudflare.com",
      "img-src 'self' data: https://*.tile.openstreetmap.org https://*.basemaps.cartocdn.com",
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
app.get('/manifest.webmanifest', (request, response) => {
  response.type('application/manifest+json').send(JSON.stringify({
    name: PWA_APP_NAME,
    short_name: PWA_APP_NAME,
    description: APP_DESCRIPTION,
    start_url: '/',
    scope: '/',
    display: 'standalone',
    display_override: ['standalone', 'minimal-ui'],
    background_color: '#07111d',
    theme_color: '#07111d',
    icons: [
      {
        src: '/logo.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/logo.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any maskable',
      },
    ],
  }));
});
app.use('/vendor/leaflet', express.static(path.join(APP_DIR, 'node_modules/leaflet/dist'), { index: false }));
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
      response.status(result.error === 'verification_unavailable' ? 503 : 400).json({
        success: false,
        error: result.error === 'verification_unavailable'
          ? 'verification_unavailable'
          : 'verification_failed',
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
      messageHashes: [],
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
    scheduleResultsWrite();
    broadcastSnapshot(true);
    response.status(201).json(serializeSession(session, request));
  },
);

app.get('/api/sessions', (request, response) => {
  const ids = dedupe(
    String(request.query?.ids || '')
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value.length > 0 && value.length <= 128),
  ).slice(0, 8);
  response.json({
    sessions: ids.map((sessionId) => {
      const session = sessions.get(sessionId);
      return session
        ? { sessionId, session: serializeSession(session, request) }
        : { sessionId, missing: true };
    }),
  });
});

app.get('/api/sessions/:sessionId', (request, response) => {
  const session = sessions.get(request.params.sessionId);
  if (!session) {
    response.status(404).json({ error: 'session_not_found' });
    return;
  }
  response.json(serializeSession(session, request));
});

function sendApp(request, response) {
  response.type('html').send(renderHtmlTemplate(appHtmlTemplate, request));
}

function sendLanding(request, response) {
  response.type('html').send(renderHtmlTemplate(landingHtmlTemplate, request, 'Verification'));
}

function sendShare(request, response) {
  // Share sessions are scoped to the expected observer set recorded at
  // creation time; surface that scope so the map renders only the observers
  // targeted by the selected region (Wave 3 BUG-013 fix).
  const shareBody = shareHtmlTemplate.replace(
    '<body class="noc-body" data-page-mode="share"',
    '<body class="noc-body" data-page-mode="share" data-map-observer-scope="expected"',
  );
  response.type('html').send(renderHtmlTemplate(shareBody, request, 'Shared Result'));
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

app.get('/share/:sessionId', (request, response) => {
  sendShare(request, response);
});

app.get(/.*/, (request, response) => {
  const requestPath = request.path;
  const isApiRoute = requestPath.startsWith('/api/');
  const hasAssetExtension = path.extname(requestPath) !== '';
  const acceptsHtml = request.accepts('html') === 'html';
  if (isApiRoute || hasAssetExtension || !acceptsHtml) {
    if (isApiRoute) {
      response.status(404).json({ error: 'not_found' });
    } else {
      response.status(404).type('text/plain').send('Not found');
    }
    return;
  }
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
let wsHeartbeatTimer = null;

function sendWebSocketPayload(payload) {
  for (const client of wss.clients) {
    if (client.readyState !== 1) {
      continue;
    }
    if (client.bufferedAmount > MAX_WS_BUFFERED_BYTES) {
      client.terminate();
      continue;
    }
    try {
      client.send(payload);
    } catch (error) {
      logger.debug(`[websocket] send failed: ${error.message || error}`);
      client.terminate();
    }
  }
}

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
  sendWebSocketPayload(payload);
}

function broadcastSessionUpdate(sessionId) {
  const payload = JSON.stringify({
    type: 'session-update',
    data: { sessionId: String(sessionId || '') },
  });
  sendWebSocketPayload(payload);
}

wss.on('connection', (socket) => {
  socket.isAlive = true;
  socket.on('pong', () => {
    socket.isAlive = true;
  });
  socket.send(JSON.stringify({
    type: 'snapshot',
    data: snapshotPayload(),
  }));
});

server.on('upgrade', (request, socket, head) => {
  if (wss.clients.size >= MAX_WS_CONNECTIONS) {
    socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

function startWebSocketHeartbeat() {
  if (wsHeartbeatTimer) {
    return;
  }
  wsHeartbeatTimer = setInterval(() => {
    for (const client of wss.clients) {
      if (client.isAlive === false) {
        client.terminate();
        continue;
      }
      client.isAlive = false;
      try {
        client.ping();
      } catch {
        client.terminate();
      }
    }
  }, WS_HEARTBEAT_INTERVAL_MS);
  wsHeartbeatTimer.unref?.();
}

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
      broadcastSnapshot();
    } else {
      broadcastSnapshot(false);
    }
  }, 10000);
  startWebSocketHeartbeat();
  startMqtt();

  server.listen(PORT, () => {
    logger.info(`[web] listening on http://localhost:${PORT}`);
    logger.info(
      `[web] using broker ${brokerLabel(MQTT_URL)} and ${
        testChannelHash ? `#${testChannelName} (${testChannelHash})` : `#${testChannelName}`
      }`,
    );
    if (!meshPacketDecoderKeyStore) {
      logger.warn('[web] no decoder key configured for the test channel');
    }
    logger.info(`[web] log level ${logger.level}`);
  });
}

let shuttingDown = false;

async function shutdownRuntime(signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger.info(`[web] shutting down on ${signal}`);
  if (pruneInterval) {
    clearInterval(pruneInterval);
    pruneInterval = null;
  }
  if (wsHeartbeatTimer) {
    clearInterval(wsHeartbeatTimer);
    wsHeartbeatTimer = null;
  }
  for (const client of wss.clients) {
    client.terminate();
  }
  if (mqttClient) {
    const client = mqttClient;
    mqttClient = null;
    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, 5000);
      client.end(true, () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }
  await Promise.race([
    flushScheduledWritesAsync(),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
  if (server.listening) {
    await new Promise((resolve) => server.close(() => resolve()));
  }
}

export function resetTestState() {
  flushScheduledWrites();
  sessions.clear();
  messageToSession.clear();
  rateLimitBuckets.clear();
  turnstileAuthTokens.clear();
  observerState.clear();
  observerActivityHistory.clear();
  for (const [key, entry] of baselineObserverActivityHistory.entries()) {
    observerActivityHistory.set(key, {
      days: { ...(entry?.days || {}) },
      lastPacketAt: Number(entry?.lastPacketAt || 0),
    });
  }
  primeObserverDirectory();
  if (!DISABLE_RESULTS_FILE_WRITES) {
    writeResultsFile();
  }
  lastSnapshotSentAt = 0;
}

export { flushScheduledWrites };

export function ingestMqttMessage(topic, payload) {
  const parts = String(topic || '').split('/');
  const streamType = parts[parts.length - 1] || '';
  const observerKey = normalizeObserverKey(parts[parts.length - 2] || '');
  if (!observerKey) {
    return;
  }
  if (streamType === 'packets') {
    handlePacketMessage(topic, observerKey, payload);
    return;
  }
  if (streamType === 'status' || streamType === 'internal') {
    if (handleObserverMetadata(topic, observerKey, payload)) {
      broadcastSnapshot();
    }
  }
}

export {
  app,
  server,
  APP_DATA_DIR,
  OBSERVERS_FILE_PATH,
  OBSERVER_ACTIVITY_FILE_PATH,
  RESULTS_FILE_PATH,
};

if (IS_MAIN_MODULE && !DISABLE_RUNTIME) {
  process.once('SIGTERM', () => { void shutdownRuntime('SIGTERM'); });
  process.once('SIGINT', () => { void shutdownRuntime('SIGINT'); });
  startRuntime();
}
