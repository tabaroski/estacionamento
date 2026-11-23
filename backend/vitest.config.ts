import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 30_000,
    // Cada arquivo sobe o próprio banco e broker em memória; em série fica mais estável.
    fileParallelism: false,
  },
});
