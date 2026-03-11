import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/smoke',
  timeout: 30000,
  fullyParallel: true,
  use: {
    browserName: 'chromium',
    headless: true,
  },
  projects: [
    {
      name: 'dashboard',
      testMatch: /dashboard\.spec\.js/,
      use: {
        baseURL: 'http://127.0.0.1:3091',
      },
    },
    {
      name: 'landing',
      testMatch: /landing\.spec\.js/,
      use: {
        baseURL: 'http://127.0.0.1:3092',
      },
    },
  ],
  webServer: [
    {
      command: 'PORT=3091 MESH_HEALTH_DISABLE_RUNTIME=true TURNSTILE_ENABLED=false APP_TITLE=\"Boston MeshCore Observer Coverage\" APP_EYEBROW=\"Boston MeshCore Observer Coverage\" OBSERVERS_FILE=./test/fixtures/observer-smoke.json node ./scripts/start-test-server.js',
      url: 'http://127.0.0.1:3091/api/bootstrap',
      reuseExistingServer: false,
    },
    {
      command: 'PORT=3092 MESH_HEALTH_DISABLE_RUNTIME=true TURNSTILE_ENABLED=true APP_TITLE=\"Boston MeshCore Observer Coverage\" APP_EYEBROW=\"Boston MeshCore Observer Coverage\" TURNSTILE_SITE_KEY=test-site-key TURNSTILE_SECRET_KEY=test-secret OBSERVERS_FILE=./test/fixtures/observer-smoke.json node ./scripts/start-test-server.js',
      url: 'http://127.0.0.1:3092/api/bootstrap',
      reuseExistingServer: false,
    },
  ],
});
