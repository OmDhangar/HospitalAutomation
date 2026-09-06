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
    /**
     * Integration files share one Postgres and name their fixtures by hospital
     * name, so running them in parallel makes them contend for the database and
     * for each other's rows. The unit suite is a second either way; the
     * integration suite is correct only this way.
     */
    fileParallelism: false,
  },
  resolve: {
    alias: { '@': fileURLToPath(new URL('.', import.meta.url)) },
  },
});
