import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['lib/**/*.test.ts'],
    setupFiles: ['dotenv/config'],
    // Integration tests round-trip to a managed Postgres in another region;
    // 5s is not enough for a test that performs a dozen sequential queries.
    testTimeout: 90_000,
    hookTimeout: 60_000,
  },
  resolve: {
    alias: { '@': fileURLToPath(new URL('.', import.meta.url)) },
  },
});
