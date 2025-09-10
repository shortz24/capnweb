import { defineConfig } from 'vite'
import path from 'node:path'

// Map '@cloudflare/jsrpc' to the repo's local dist build so we can run
// the example without publishing to npm.
export default defineConfig({
  resolve: {
    alias: {
      '@cloudflare/jsrpc': path.resolve(__dirname, '../../../dist/index.js'),
    },
  },
  // Ensure modern output so top-level await is allowed (library uses it).
  build: {
    target: 'esnext',
  },
  esbuild: {
    target: 'esnext',
    supported: {
      'top-level-await': true,
    },
  },
})
