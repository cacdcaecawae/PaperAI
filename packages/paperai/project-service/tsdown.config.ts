import { defineConfig } from 'tsdown'

/** Build the project service and its invariant companion. */
export default defineConfig([
  {
    entry: ['lib/types/index.js', 'lib/types/layout.js', 'lib/types/git.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  {
    entry: ['lib/types/invariant.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
])
