import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    environment: 'node',
    // Component tests (render + DOM assertions) need jsdom; plain logic tests
    // stay on the lighter 'node' environment above.
    environmentMatchGlobs: [['src/**/*.test.tsx', 'jsdom']],
    setupFiles: ['./src/__tests__/setup.ts'],
  },
});
