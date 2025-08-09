import { defineConfig } from 'vitest/config'

export default defineConfig({
  esbuild: {
    target: 'es2022', // Transpile using syntax for browser compatibility
  },
  test: {
    projects: [
      // Node.js
      {
        test: {
          name: 'node',
          include: ['__tests__/index.test.ts'],
          environment: 'node',
        },
      },

      // Cloudflare Workers
      {
        test: {
          name: 'workerd',
          include: ['__tests__/index.test.ts', '__tests__/workerd.test.ts'],
          pool: '@cloudflare/vitest-pool-workers',
          poolOptions: {
            workers: {
              miniflare: {
                compatibilityDate: '2025-07-01',
              },
            },
          },
        },
      },

      // Browsers which natively support the `using` keyword (Explicit Resource Management).
      {
        test: {
          name: 'browsers-with-using',
          include: ['__tests__/index.test.ts'],
          browser: {
            enabled: true,
            provider: 'playwright',
            instances: [
              // Currently only Chromium supports this.
              { browser: 'chromium' },
            ],
            headless: true,
          },
        },
      },

      // Browsers with the `using` keyword transpiled to try/catch.
      {
        esbuild: {
          target: 'es2022',
        },
        test: {
          name: 'browsers-without-using',
          include: ['__tests__/index.test.ts'],
          browser: {
            enabled: true,
            provider: 'playwright',
            instances: [
              // We re-test Chromium in this mode since it's likely users will want to serve the
              // same JavaScript to all browsers, so will have to use this mode until `using`
              // becomes widely available.
              { browser: 'chromium' },
              { browser: 'firefox' },
              { browser: 'webkit' },
            ],
            headless: true,
          },
        },
      },
    ],
  },
})