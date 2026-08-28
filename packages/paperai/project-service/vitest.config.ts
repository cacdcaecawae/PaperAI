import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { defineConfig } from 'vitest/config'

const root = fileURLToPath(new URL('../../../', import.meta.url))

/** Isolated source-resolution and coverage config for the not-yet-bundled package. */
export default defineConfig({
  root,
  resolve: {
    tsconfigPaths: true,
    alias: {
      '@paperai/domain': join(root, 'packages/paperai/domain/src/index.ts'),
      '@paperai/repository': join(root, 'packages/paperai/repository/src/index.ts'),
    },
  },
  test: {
    include: ['packages/paperai/project-service/tests/**/*.spec.ts'],
    setupFiles: [join(root, 'scripts/test-invariants.ts')],
    coverage: {
      provider: 'v8',
      include: ['packages/paperai/project-service/src/**/*.ts'],
      thresholds: {
        perFile: true,
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
      reporter: ['text'],
    },
  },
})
