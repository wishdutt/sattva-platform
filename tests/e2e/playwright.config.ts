import { defineConfig, devices } from '@playwright/test';

/**
 * Browser E2E tests against the local stack:
 *   - API: in-memory store, dev auth, mock mailer (+ real LiveKit if LIVEKIT_* env vars are set)
 *   - Web: Next.js dev server in dev-auth mode
 */
export default defineConfig({
  testDir: '.',
  timeout: 60_000,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: '../../playwright-report' }]],
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'retain-on-failure',
    // Fake camera/mic so the broadcaster flow can run headless when LiveKit is configured.
    launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] },
    permissions: ['camera', 'microphone'],
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'npx tsx services/api/src/local/server.ts',
      cwd: '../..',
      url: 'http://localhost:4000/health',
      reuseExistingServer: !process.env.CI,
      env: { PORT: '4000', WEB_BASE_URL: 'http://localhost:3000' },
    },
    {
      command: 'npm run dev -w @lsp/web',
      cwd: '../..',
      url: 'http://localhost:3000/login',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { NEXT_PUBLIC_AUTH_MODE: 'dev', NEXT_PUBLIC_API_URL: 'http://localhost:4000', NEXT_TELEMETRY_DISABLED: '1' },
    },
  ],
});
