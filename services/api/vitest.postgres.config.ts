import { defineConfig } from 'vitest/config';

/** Runs the full API suite against PostgresStore (PGlite) instead of MemoryStore. */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/dynamo.test.ts'],
    environment: 'node',
    restoreMocks: true,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: { TEST_STORE: 'postgres' },
  },
});
