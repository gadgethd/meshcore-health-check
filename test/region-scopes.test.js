import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

function run(code) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    encoding: 'utf8', timeout: 30000,
    env: { ...process.env, MESH_HEALTH_DISABLE_RUNTIME: 'true', TURNSTILE_ENABLED: 'false', MESHCORE_REGION_SCOPES_FILE: '' },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

test('strict bounded public-only YAML config and startup capability', () => run(`
  import assert from 'node:assert/strict';
  import fs from 'node:fs';
  import os from 'node:os';
  import path from 'node:path';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mhc-scopes-'));
  const file = path.join(dir, 'scopes.yml');
  let counter = 0;
  async function load(text) {
    fs.writeFileSync(file, text);
    process.env.MESHCORE_REGION_SCOPES_FILE = file;
    return import('./server.js?config=' + counter++);
  }
  try {
    for (const [text, count] of [['regions: []', 0], ['regions: ["#Fictional-Cloud", "Fictional-Moon"]', 2]]) {
      const {server} = await load(text);
      await new Promise(r => server.listen(0, '127.0.0.1', r));
      const bootstrap = await (await fetch('http://127.0.0.1:' + server.address().port + '/api/bootstrap')).json();
      assert.deepEqual(bootstrap.meshcoreScopes, { enabled: true, count });
      await new Promise(r => server.close(r));
    }
    for (const text of ['[', '', '[]', 'regions: no', 'regions: [null]', 'regions: [42]', 'regions: [""]', 'regions: ["#"]', 'regions: ["$private"]', 'regions: ["#$private"]', 'regions: ["*ط"]', 'regions: [" a"]', 'regions: ["a", "#a"]', 'regions: []\\nextra: true', 'regions: []\\nregions: []', 'regions: [!foo bar]', 'regions: &a [*a]', 'regions: []\\n---\\nregions: []', 'regions: ["' + 'x'.repeat(129) + '"]', 'regions: [' + Array(1025).fill('"a"').join(',') + ']', '#'.repeat(65537)]) {
      await assert.rejects(load(text), /MESHCORE_REGION_SCOPES_FILE/, text.slice(0, 80));
    }
    process.env.MESHCORE_REGION_SCOPES_FILE = path.join(dir, 'missing');
    await assert.rejects(import('./server.js?missing'), /MESHCORE_REGION_SCOPES_FILE/);
    process.env.MESHCORE_REGION_SCOPES_FILE = dir;
    await assert.rejects(import('./server.js?directory'), /MESHCORE_REGION_SCOPES_FILE/);
    fs.chmodSync(file, 0);
    process.env.MESHCORE_REGION_SCOPES_FILE = file;
    try {
      // Root can read chmod(0) files; the suite's documented Docker run uses the host UID.
      if (process.getuid?.() !== 0) await assert.rejects(import('./server.js?unreadable'), /MESHCORE_REGION_SCOPES_FILE/);
    } finally { fs.chmodSync(file, 0o600); }
    fs.writeFileSync(file, Buffer.from([0xff,0xfe]));
    await assert.rejects(import('./server.js?invalid-utf8'), /MESHCORE_REGION_SCOPES_FILE/);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
`));

test('public names obey firmware byte characters and pre-hashtag storage without truncation', () => run(`
  import assert from 'node:assert/strict';
  import fs from 'node:fs';
  import os from 'node:os';
  import path from 'node:path';
  import { loadMeshcoreScopes } from './lib/meshcore-scopes.js';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mhc-name-bounds-'));
  const file = path.join(dir, 'scopes.yml');
  function load(name) {
    fs.writeFileSync(file, JSON.stringify({regions:[name]}));
    return loadMeshcoreScopes(file).regions;
  }
  try {
    // RegionMap stores at most 30 bytes BEFORE an implicit '#'. An explicit '#' uses a byte.
    for (const name of ['Fictional-Cloud', '#Fictional-Moon', 'a'.repeat(30), '#' + 'a'.repeat(29), '\\u00e9'.repeat(15), '#' + '\\u00e9'.repeat(14) + 'a', 'A_Z[Q]^R' ]) {
      assert.deepEqual(load(name), [name.startsWith('#') ? name : '#' + name]);
    }
    for (const name of ['a.b', 'a/b', 'a:b', 'a@b', 'a,b', 'a'.repeat(31), '#' + 'a'.repeat(30), '\\u00e9'.repeat(15) + 'a', '#' + '\\u00e9'.repeat(15)]) {
      assert.throws(() => load(name), /MESHCORE_REGION_SCOPES_FILE.*(firmware|30 UTF-8 bytes)/, name);
    }
  } finally { fs.rmSync(dir, {recursive:true, force:true}); }
`));

test('encrypted received scopes remain per-observer and survive changed/disabled configuration', () => run(`
  import assert from 'node:assert/strict';
  import fs from 'node:fs';
  import os from 'node:os';
  import path from 'node:path';
  import { createRequire } from 'node:module';
  import { buildGroupTextEnvelope } from './test/support/build-meshcore-fixture.js';
  const decoder = createRequire(import.meta.url)('@michaelhart/meshcore-decoder');
  const {calcTransportCodeForRegion} = decoder;
  let comparisons = 0;
  for (const method of ['transportCodeMatchesRegion', 'calcTransportCode']) {
    const original = decoder[method];
    Object.defineProperty(decoder, method, {value:(...args) => { comparisons++; return original(...args); }, configurable:true});
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mhc-scope-rf-'));
  process.env.MESH_HEALTH_DISABLE_RUNTIME = 'false';
  process.env.OBSERVERS_FILE = path.join(dir, 'observers.json');
  process.env.OBSERVER_ACTIVITY_FILE = path.join(dir, 'activity.json');
  process.env.RESULTS_FILE = path.join(dir, 'results.json');
  process.env.TEST_CHANNEL_SECRET = 'E6D973AAC5101145AD3A3F3A0B3D52EB';
  process.env.KNOWN_OBSERVERS = '';
  process.env.INITIAL_REGION = '';
  process.env.ALLOWED_REGIONS = '';
  process.env.ALLOWED_REGION_GROUPS = '';
  const file = path.join(dir, 'scopes.yml');
  const names = Array.from({length: 1000}, (_, i) => '#Fictional-' + i);
  fs.writeFileSync(file, JSON.stringify({ regions: names }));
  process.env.MESHCORE_REGION_SCOPES_FILE = file;
  const api = await import('./server.js?rf');
  await new Promise(r => api.server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + api.server.address().port;
  const keys = ['1'.repeat(64), '2'.repeat(64)];
  for (const key of keys) api.ingestMqttMessage('meshcore/LAB/' + key + '/status', Buffer.from(JSON.stringify({name:'Synthetic observer'})));
  const session = await (await fetch(base + '/api/sessions', {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({expectedObserverKeys:keys})})).json();
  function fixture(timestamp = 1760000000) {
    return buildGroupTextEnvelope({secretHex:process.env.TEST_CHANNEL_SECRET, sender:'Synthetic Scope', message:session.code, messageHash:'aabbccdd11223344', timestamp});
  }
  function scoped(envelope, code, route = 0) {
    const bytes = Buffer.from(envelope.raw, 'hex');
    const transport = Buffer.alloc(4); transport.writeUInt16LE(code); transport.writeUInt16LE(54321, 2);
    return {...envelope, raw:Buffer.concat([Buffer.from([(5 << 2) | route]), transport, bytes.subarray(1)]).toString('hex')};
  }
  function ingest(envelope, key = keys[0]) { api.ingestMqttMessage('meshcore/LAB/' + key + '/packets', Buffer.from(JSON.stringify(envelope))); }
  const get = async () => (await fetch(base + '/api/sessions/' + session.id)).json();
  try {
    const envelope = fixture();
    const payload = Buffer.from(envelope.raw, 'hex').subarray(2);
    const code = calcTransportCodeForRegion(names[0], 5, payload);
    const unrelated = buildGroupTextEnvelope({secretHex:process.env.TEST_CHANNEL_SECRET, sender:'Synthetic Scope', message:'Unrelated channel conversation', messageHash:'bbccdd1122334455', timestamp:1760000000});
    ingest(scoped(unrelated, code));
    assert.equal(comparisons, 0, 'unmatched decrypted scoped traffic performs no scope comparisons');
    ingest(scoped(envelope, code));
    assert.equal(comparisons, names.length, 'eligible receipt compares each public region once');
    let result = await get();
    const expectedNames = names.filter(n => calcTransportCodeForRegion(n, 5, payload) === code);
    assert.deepEqual(result.receipts[0].meshcoreScopes, [{state:expectedNames.length > 1 ? 'ambiguous' : 'known', names:expectedNames}]);
    assert.equal(result.useCount, 1); assert.equal(result.healthPercent, 50);
    ingest(envelope); // Forwarded without transport codes: do not overwrite the first scope.
    ingest(scoped(envelope, 0), keys[1]);
    result = await get();
    assert.equal(result.useCount, 1); assert.equal(result.healthPercent, 100);
    assert.equal(result.receipts[0].count, 2);
    assert.deepEqual(result.receipts[0].meshcoreScopes.at(-1), {state:'unscoped', names:[]});
    assert.deepEqual(result.receipts[1].meshcoreScopes, [{state:'unscoped', names:[]}]);
    let unknown = 1;
    while(names.some(n => calcTransportCodeForRegion(n,5,payload) === unknown)) unknown++;
    ingest(scoped(envelope, unknown, 3));
    assert.deepEqual((await get()).receipts[0].meshcoreScopes.at(-1), {state:'unknown', names:[]});
    // Real deterministic birthday collision: same encrypted payload, two synthetic public names.
    let collision;
    for (let t = 0; !collision && t < 10; t++) {
      const candidate = fixture(1760000000 + t);
      const bytes = Buffer.from(candidate.raw,'hex').subarray(2);
      const codes = new Map();
      for (const name of names) {
        const c = calcTransportCodeForRegion(name,5,bytes);
        if (codes.has(c)) { collision = {envelope:candidate, code:c, names:names.filter(n => calcTransportCodeForRegion(n,5,bytes) === c)}; break; }
        codes.set(c,name);
      }
    }
    assert.ok(collision, 'synthetic 16-bit collision found');
    ingest(scoped(collision.envelope, collision.code));
    result = await get();
    assert.deepEqual(result.receipts[0].meshcoreScopes.at(-1), {state:'ambiguous', names:collision.names});
    const before = structuredClone(result.receipts);
    ingest({...envelope, raw:'140100'}); // Truncated transport packet never adds a receipt.
    assert.deepEqual((await get()).receipts, before);
    await api.flushScheduledWrites();
    for (const setting of ['', file]) {
      fs.writeFileSync(file, 'regions: ["#Fictional-Replacement"]');
      process.env.MESHCORE_REGION_SCOPES_FILE = setting;
      const reloaded = await import('./server.js?reload-scope=' + encodeURIComponent(setting));
      await new Promise(r => reloaded.server.listen(0,'127.0.0.1',r));
      const restored = await (await fetch('http://127.0.0.1:' + reloaded.server.address().port + '/api/sessions/' + session.id)).json();
      assert.deepEqual(restored.receipts, before);
      await new Promise(r => reloaded.server.close(r));
    }
    // A pre-feature receipt is explicitly unknown historically, not "unscoped".
    const legacyStore = JSON.parse(fs.readFileSync(process.env.RESULTS_FILE, 'utf8'));
    for (const record of legacyStore.sessions) for (const receipt of record.receipts) delete receipt.meshcoreScopes;
    fs.writeFileSync(process.env.RESULTS_FILE, JSON.stringify(legacyStore));
    const legacy = await import('./server.js?legacy-scopes');
    await new Promise(r => legacy.server.listen(0,'127.0.0.1',r));
    const old = await (await fetch('http://127.0.0.1:' + legacy.server.address().port + '/api/sessions/' + session.id)).json();
    assert.deepEqual(old.receipts[0].meshcoreScopes, [{state:'not-present', names:[]}]);
    await new Promise(r => legacy.server.close(r));
    // Expiry must also gate already-mapped hashes before the periodic prune runs.
    const realNow = Date.now;
    const beforeExpired = comparisons;
    try {
      Date.now = () => session.expiresAt + 1;
      ingest(scoped(envelope, code));
      assert.equal(comparisons, beforeExpired, 'expired matched packets perform no scope comparisons');
    } finally { Date.now = realNow; }
  } finally {
    await api.flushScheduledWrites();
    await new Promise(r => api.server.close(r));
    fs.rmSync(dir, {recursive:true, force:true});
  }
`));

test('region keys are prepared once and binary payload is reused for every comparison', () => run(`
  import assert from 'node:assert/strict';
  import fs from 'node:fs';
  import os from 'node:os';
  import path from 'node:path';
  import { createRequire } from 'node:module';
  const decoder = createRequire(import.meta.url)('@michaelhart/meshcore-decoder');
  let keyCalls = 0, codeCalls = 0;
  const payloadBytes = Buffer.alloc(180, 0xab);
  const regionNames = ['#Fictional-Cloud', '#Fictional-Moon'];
  const code = decoder.calcTransportCodeForRegion(regionNames[0], 5, payloadBytes);
  for (const method of ['calcRegionKey', 'calcTransportCode']) {
    const original = decoder[method];
    Object.defineProperty(decoder, method, {configurable:true, value:(...args) => {
      if (method === 'calcRegionKey') keyCalls++;
      else { codeCalls++; assert.strictEqual(args[2], payloadBytes, 'one binary payload, not per-region hex reparsing'); }
      return original(...args);
    }});
  }
  const { loadMeshcoreScopes, recognizeMeshcoreScope } = await import('./lib/meshcore-scopes.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mhc-scope-cache-'));
  try {
    const file = path.join(dir,'scopes.yml');
    fs.writeFileSync(file, JSON.stringify({regions:regionNames}));
    const config = loadMeshcoreScopes(file);
    assert.equal(keyCalls, 2, 'prepare public keys at startup, not per received packet');
    const packet = {routeType:0,payloadType:5,payloadBytes,transportCodes:[code,42]};
    const expected = {state:'known',names:[regionNames[0]]};
    assert.deepEqual(recognizeMeshcoreScope(config,packet), expected);
    assert.deepEqual(recognizeMeshcoreScope(config,packet), expected);
    assert.equal(keyCalls,2);
    assert.equal(codeCalls,4);
    const direct = {enabled:true,regions:regionNames};
    assert.deepEqual(recognizeMeshcoreScope(direct,packet),expected);
    assert.deepEqual(recognizeMeshcoreScope(direct,packet),expected);
    assert.equal(keyCalls,4, 'plain helper configurations also reuse prepared keys');
    direct.regions[0] = '#Fictional-Replacement';
    assert.deepEqual(recognizeMeshcoreScope(direct,packet), {state:'unknown',names:[]});
    assert.equal(keyCalls,6, 'mutated direct configuration cannot use stale cached keys');
    recognizeMeshcoreScope({enabled:false,regions:['#Fictional-Unused']},packet);
    recognizeMeshcoreScope(direct,{...packet,transportCodes:[0,code]});
    assert.equal(keyCalls,6, 'disabled and unscoped packets do not prepare keys');
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
`));

test('packet-dependent public-name candidates, disabled/empty config, and unavailable states', async () => {
  const { recognizeMeshcoreScope, recordedMeshcoreScopes } = await import('../lib/meshcore-scopes.js');
  const { createRequire } = await import('node:module');
  const {calcTransportCodeForRegion} = createRequire(import.meta.url)('@michaelhart/meshcore-decoder');
  const payloadBytes = Buffer.from('0102030405060708090a0b0c0d0e0f10111213', 'hex');
  const code = calcTransportCodeForRegion('#Fictional-Cloud', 5, payloadBytes);
  const packet = {routeType:0, payloadType:5, payloadBytes, transportCodes:[code,0]};
  assert.deepEqual(recognizeMeshcoreScope({enabled:true, regions:['#Fictional-Cloud','#fictional-cloud']}, packet), {state:'known',names:['#Fictional-Cloud']});
  assert.deepEqual(recognizeMeshcoreScope({enabled:false, regions:[]},packet), {state:'disabled',names:[]});
  assert.deepEqual(recognizeMeshcoreScope({enabled:true, regions:[]},packet), {state:'unknown',names:[]});
  assert.deepEqual(recognizeMeshcoreScope({enabled:true, regions:['#Fictional-Cloud']}, {...packet,payloadBytes:Buffer.from('different encrypted payload')}), {state:'unknown',names:[]});
  for (const incomplete of [null, {...packet,payloadType:4}, {...packet,payloadBytes:null}, {...packet,transportCodes:[]}]) {
    assert.deepEqual(recognizeMeshcoreScope({enabled:true,regions:[]}, incomplete), {state:'unavailable',names:[]});
  }
  for (const ordinary of [1,2]) assert.equal(recognizeMeshcoreScope({enabled:false,regions:[]}, {...packet,routeType:ordinary}).state, 'unscoped');
  assert.equal(recognizeMeshcoreScope({enabled:false,regions:[]}, {...packet,transportCodes:[0,code]}).state, 'unscoped');
  assert.deepEqual(recordedMeshcoreScopes(undefined), [{state:'not-present',names:[]}]);
  const codes = new Map();
  let pair;
  for (let i=0; i<1024; i++) {
    const name = '#Fictional-Collision-' + i;
    const c = calcTransportCodeForRegion(name,5,payloadBytes);
    if (codes.has(c)) { pair = [codes.get(c),name]; packet.transportCodes=[c,555]; break; }
    codes.set(c,name);
  }
  assert.ok(pair);
  assert.deepEqual(recognizeMeshcoreScope({enabled:true,regions:pair},packet),{state:'ambiguous',names:pair});
  console.log('Synthetic collision evidence:',JSON.stringify({payload:payloadBytes.toString('hex'),code:packet.transportCodes[0],names:pair}));
});

test('prepared matching preserves decoder parity, reserved codes and first-code-only semantics', async () => {
  const { recognizeMeshcoreScope } = await import('../lib/meshcore-scopes.js');
  const { createRequire } = await import('node:module');
  const { createHmac } = await import('node:crypto');
  const {calcRegionKey, calcTransportCodeForRegion} = createRequire(import.meta.url)('@michaelhart/meshcore-decoder');
  const config = {enabled:true, regions:Array.from({length:64}, (_, i) => '#Fictional-Parity-' + i)};
  for (const size of [1, 19, 180]) {
    const payloadBytes = Buffer.alloc(size, 0xab);
    const code = calcTransportCodeForRegion(config.regions[0], 5, payloadBytes);
    const names = config.regions.filter(name => calcTransportCodeForRegion(name,5,payloadBytes) === code);
    const packet = {routeType:3,payloadType:5,payloadBytes,transportCodes:[code,12345]};
    assert.deepEqual(recognizeMeshcoreScope(config,packet), {state:names.length > 1 ? 'ambiguous' : 'known', names});
    assert.deepEqual(recognizeMeshcoreScope(config,{...packet,transportCodes:[code,54321]}), recognizeMeshcoreScope(config,packet));
  }
  const name = '#Fictional-Reserved';
  for (const [hex, rawCode, code] of [['347d0000',0,1], ['fa320000',65535,65534]]) {
    const payloadBytes = Buffer.from(hex,'hex');
    assert.equal(createHmac('sha256',calcRegionKey(name)).update(Buffer.from([5])).update(payloadBytes).digest().readUInt16LE(), rawCode);
    assert.equal(calcTransportCodeForRegion(name,5,payloadBytes), code);
    const packet = {routeType:0,payloadType:5,payloadBytes,transportCodes:[code,0]};
    assert.deepEqual(recognizeMeshcoreScope({enabled:true,regions:[name]},packet), {state:'known',names:[name]});
    assert.deepEqual(recognizeMeshcoreScope({enabled:true,regions:[name]}, {...packet,transportCodes:[12345,code]}), {state:'unknown',names:[]});
  }
});

test('MeshCore scope recognition defaults to disabled without changing geographic scope', () => run(`
  import assert from 'node:assert/strict';
  const { server } = await import('./server.js');
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const bootstrap = await (await fetch('http://127.0.0.1:' + server.address().port + '/api/bootstrap')).json();
    assert.deepEqual(bootstrap.meshcoreScopes, { enabled: false, count: 0 });
  } finally { await new Promise(r => server.close(r)); }
`));
