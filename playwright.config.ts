import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  // Directory where test files live
  testDir: './e2e',

  // Run all tests in parallel
  fullyParallel: true,

  // Fail the build on CI if test.only is accidentally left in source
  forbidOnly: !!process.env['CI'],

  // Retry failed tests once on CI
  retries: process.env['CI'] ? 1 : 0,

  // Number of workers
  workers: process.env['CI'] ? 1 : undefined,

  // Reporter: html report + console list
  reporter: [['html', { outputFolder: 'playwright-report' }], ['list']],

  use: {
    // Base URL — matches `ng serve` default port
    baseURL: 'http://localhost:4200',

    // Collect trace on first retry for debugging
    trace: 'on-first-retry',

    // Capture screenshot on failure
    screenshot: 'only-on-failure',

    // 5-second default timeout for actions
    actionTimeout: 5_000,
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },
  ],

  // Auto-start the Angular dev server before running tests.
  // If you already have `ng serve` running, Playwright will reuse it.
  webServer: {
    command: 'npm run start',
    url: 'http://localhost:4200',
    timeout: 120_000,          // give Angular up to 2 min to compile on first run
    reuseExistingServer: true, // reuse a running server instead of starting a new one
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
