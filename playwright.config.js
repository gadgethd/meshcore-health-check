import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/smoke',
  timeout: 30000,
  fullyParallel: true,
  outputDir: 'test-results',
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
  ],
  use: {
    browserName: 'chromium',
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    // Exercise the real WebGL renderer on GPU-less CI hosts.
    launchOptions: {
      args: ['--enable-unsafe-swiftshader'],
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}),
    },
  },
  projects: [
    {
      name: 'code-length',
      testMatch: /code-length\.spec\.js/,
      use: { baseURL: 'http://127.0.0.1:3093', serviceWorkers: 'block' },
    },
    {
      name: 'dashboard',
      testMatch: /(?:^|[\\/])(?:dashboard|guided)\.spec\.js$/,
      use: {
        baseURL: 'http://127.0.0.1:3091',
        serviceWorkers: 'block',
      },
    },
    {
      name: 'pwa',
      testMatch: /(?:pwa|pwa-dashboard)\.spec\.js/,
      use: {
        baseURL: 'http://127.0.0.1:3091',
      },
    },
    {
      name: 'landing',
      testMatch: /(?:landing|turnstile)\.spec\.js/,
      use: {
        baseURL: 'http://127.0.0.1:3092',
      },
    },
  ],
  webServer: [
    {
      command: 'PORT=3093 CODE_PREFIX=NYHC1234 ALLOW_LONGER_TEST_CODES=true MESH_HEALTH_DISABLE_RUNTIME=true TURNSTILE_ENABLED=false OBSERVERS_FILE=./test/fixtures/observer-smoke.json KNOWN_OBSERVERS=AF07FC2005E04D08DDA921E64985E62201BF974AE0B0E35084B804229ED11A2B,01F0E86393494B0BE83E3D93BD528456DE39F389B9DCF802BC90B21F66EA88A6 node ./scripts/start-test-server.js',
      url: 'http://127.0.0.1:3093/api/bootstrap',
      reuseExistingServer: false,
    },
    {
      command: 'PORT=3091 MESH_HEALTH_DISABLE_RUNTIME=true TURNSTILE_ENABLED=false APP_TITLE=\"MeshCore Observer Coverage\" APP_EYEBROW=\"MeshCore Observer Coverage\" OBSERVERS_FILE=./test/fixtures/observer-smoke.json KNOWN_OBSERVERS=AF07FC2005E04D08DDA921E64985E62201BF974AE0B0E35084B804229ED11A2B,01F0E86393494B0BE83E3D93BD528456DE39F389B9DCF802BC90B21F66EA88A6 node ./scripts/start-test-server.js',
      url: 'http://127.0.0.1:3091/api/bootstrap',
      reuseExistingServer: false,
    },
    {
      command: 'PORT=3092 MESH_HEALTH_DISABLE_RUNTIME=true TURNSTILE_ENABLED=true TURNSTILE_API_URL=http://127.0.0.1:3094/siteverify APP_TITLE=\"MeshCore Observer Coverage\" APP_EYEBROW=\"MeshCore Observer Coverage\" TURNSTILE_SITE_KEY=test-site-key TURNSTILE_SECRET_KEY=test-secret OBSERVERS_FILE=./test/fixtures/observer-smoke.json KNOWN_OBSERVERS=AF07FC2005E04D08DDA921E64985E62201BF974AE0B0E35084B804229ED11A2B,01F0E86393494B0BE83E3D93BD528456DE39F389B9DCF802BC90B21F66EA88A6 node ./scripts/start-test-server.js',
      url: 'http://127.0.0.1:3092/api/bootstrap',
      reuseExistingServer: false,
    },
    {
      command: 'TURNSTILE_MOCK_PORT=3094 node ./scripts/mock-turnstile-server.js',
      url: 'http://127.0.0.1:3094/health',
      reuseExistingServer: false,
    },
  ],
});
