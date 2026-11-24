import fs from 'node:fs';
import { createRequire } from 'node:module';
import { parseDocument, visit } from 'yaml';

const require = createRequire(import.meta.url);
const { normalizeRegionName, calcRegionKey, calcTransportCode } = require('@michaelhart/meshcore-decoder');

// Config-owned cache: no packet/payload cache and no unbounded global name registry.
const preparedRegions = new WeakMap();
function regionKeys(config) {
  let entries = preparedRegions.get(config);
  // The loader's roster is stable; direct helper callers may replace/mutate theirs.
  if (!entries || entries.length !== config.regions.length
    || entries.some((entry, index) => entry.name !== config.regions[index])) {
    entries = config.regions.map(name => ({ name, key: calcRegionKey(name) }));
    preparedRegions.set(config, entries);
  }
  return entries;
}

// Operator-owned, local public names only; never fetch a registry or accept keys.
export function loadMeshcoreScopes(filePath) {
  if (!filePath) return { enabled: false, regions: [] };
  try {
    const fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    let text;
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > 65536) throw new Error('must be a regular file of at most 65536 bytes');
      const bytes = Buffer.alloc(65537);
      const length = fs.readSync(fd, bytes, 0, bytes.length, 0);
      if (length > 65536) throw new Error('file exceeds 65536 bytes');
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
    } finally { fs.closeSync(fd); }
    const doc = parseDocument(text, { schema: 'core', uniqueKeys: true, strict: true });
    if (doc.errors.length || doc.warnings.length) throw new Error('invalid YAML (one document, unique keys, standard tags required)');
    let nodes = 0;
    visit(doc, {
      Node(key, node) {
        if (++nodes > 4096 || node.anchor) throw new Error('anchors or excessive YAML complexity are unsupported');
      },
      Alias() { throw new Error('YAML aliases are unsupported'); },
    });
    const value = doc.toJS({ maxAliasCount: 0 });
    if (!value || Array.isArray(value) || typeof value !== 'object'
      || Object.keys(value).length !== 1 || !Array.isArray(value.regions)
      || value.regions.length > 1024) {
      throw new Error('expected only regions: [public name strings], at most 1024 names');
    }
    const regions = value.regions.map((name) => {
      // MeshCore RegionMap::is_name_char(uint8_t): '-', '$', '#', digits, or >= 'A'.
      // Retain our public-only subset: one optional leading '#', no '$', whitespace or controls.
      // RegionEntry::name[31] stores 30 bytes INCLUDING an explicit '#'; bare names
      // gain their implicit '#' only in getTransportKeysFor(), after storage.
      if (typeof name !== 'string' || !/^#?[^#$*\s\p{C}]+$/u.test(name)
        || !Buffer.from(name, 'utf8').every(byte => byte === 45 || byte === 35
          || (byte >= 48 && byte <= 57) || byte >= 65)) {
        throw new Error('names must be public firmware-compatible strings (optional leading #); no whitespace, $, wildcard, controls or firmware-invalid punctuation');
      }
      if (Buffer.byteLength(name, 'utf8') > 30) {
        throw new Error('names must fit firmware storage: at most 30 UTF-8 bytes as written (including an explicit #); names are never truncated');
      }
      return normalizeRegionName(name);
    });
    if (new Set(regions).size !== regions.length) throw new Error('duplicate normalized public names');
    const config = { enabled: true, regions };
    regionKeys(config);
    return config;
  } catch (error) {
    throw new Error(`MESHCORE_REGION_SCOPES_FILE: ${error.message}`);
  }
}

// Call only after successful GroupText decoding, with the original wire payload.
// Firmware RegionMap::findMatch tests code[0]; code[1] is not a second region ID.
export function recognizeMeshcoreScope(config, packet) {
  const result = (state, names = []) => ({ state, names });
  if (!packet || packet.payloadType !== 5 || !packet.payloadBytes?.length) return result('unavailable');
  if (packet.routeType === 1 || packet.routeType === 2) return result('unscoped');
  if (!Array.isArray(packet.transportCodes) || packet.transportCodes.length !== 2) return result('unavailable');
  if (packet.transportCodes[0] === 0) return result('unscoped');
  if (!config.enabled) return result('disabled');
  // parsePacketHex supplies the full binary payload once. The installed decoder
  // handles HMAC, little-endian truncation and the reserved 0/0xffff adjustment.
  const names = regionKeys(config).filter(({ key }) => calcTransportCode(
    key, packet.payloadType, packet.payloadBytes,
  ) === (packet.transportCodes[0] & 0xffff)).map(({ name }) => name);
  return result(names.length > 1 ? 'ambiguous' : names.length === 1 ? 'known' : 'unknown', names);
}

// Never recalculate historical observations using today's operator file.
export function recordedMeshcoreScopes(value) {
  if (!Array.isArray(value) || !value.length) return [{ state: 'not-present', names: [] }];
  return value.filter(scope => scope && ['known', 'ambiguous', 'unknown', 'unscoped', 'disabled', 'unavailable', 'not-present'].includes(scope.state)
    && Array.isArray(scope.names) && scope.names.every(name => typeof name === 'string'))
    .map(scope => ({ state: scope.state, names: [...scope.names] }));
}
