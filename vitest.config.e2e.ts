import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    // The suites share one database (and the platform settings row) and clean up by
    // prefix, so running files in parallel lets one suite delete another's fixtures.
    fileParallelism: false,
    include: ['**/*.e2e-spec.ts'],
  },
});
