import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');

function workerContext(overrides = {}) {
  const handlers = {};
  vm.runInNewContext(source, {
    self: {
      location: { origin: 'https://healthcheck.example.test' },
      addEventListener: (type, handler) => { handlers[type] = handler; },
      clients: { claim() {} },
    },
    URL,
    Request,
    ...overrides,
  });
  return handlers;
}

test('service worker leaves tile requests to the browser HTTP cache', () => {
  const handlers = workerContext({
    fetch: () => assert.fail('Tile fetch must retain normal HTTP cache behavior'),
    caches: { match: () => assert.fail('Tile must not use PWA Cache Storage') },
  });
  handlers.fetch({
    request: new Request('https://healthcheck.example.test/tiles/osm/10/511/340.png'),
    respondWith: () => assert.fail('Tile request must pass through without interception'),
  });
});

test('service worker retires the old asset cache during activation', async () => {
  const deleted = [];
  const handlers = workerContext({
    caches: {
      keys: async () => ['mesh-health-check-pwa-v3', 'mesh-health-check-pwa-v4'],
      delete: async (name) => deleted.push(name),
    },
  });
  let activation;
  handlers.activate({ waitUntil: (task) => { activation = task; } });
  await activation;
  assert.deepEqual(deleted, ['mesh-health-check-pwa-v3']);
});
