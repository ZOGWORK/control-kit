import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 20_000,
  retries: 0,
  use: { baseURL: 'http://127.0.0.1:5173', browserName: 'chromium', channel: process.env.PLAYWRIGHT_CHANNEL || undefined, headless: true },
  webServer: { command: 'pnpm --filter @control-kit/web dev', url: 'http://127.0.0.1:5173', timeout: 30_000, reuseExistingServer: false },
});
