import { defineConfig } from 'vitest/config';

/**
 * Shared test config. Per-package `pnpm test` runs `vitest run` in the package's
 * cwd (turbo fans these out, with caching); a root `pnpm vitest` runs them all at
 * once. Both resolve this config by walking up, with `root` = their own cwd, so we
 * keep Vitest's default cwd-relative `**` include rather than a fixed path — a
 * path-based include would only match from the repo root and miss per-package runs.
 */
export default defineConfig({
  test: {
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['packages/*/src/**', 'apps/*/src/**'],
      exclude: ['**/*.test.ts', '**/dist/**', '**/__fixtures__/**'],
    },
  },
});
