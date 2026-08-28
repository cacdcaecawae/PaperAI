import { defineConfig } from 'tsdown'

/** Build the repository service, schema, and invariant companion. */
export default defineConfig([
  {
    entry: ['lib/types/index.js', 'lib/types/spec.js', 'lib/types/invariant.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
])
