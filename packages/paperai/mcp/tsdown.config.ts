import { defineConfig } from 'tsdown'

/** Build the PaperAI MCP Host plugin, server factory, public types, and invariant companion. */
export default defineConfig([
  {
    entry: [
      'lib/types/index.js',
      'lib/types/server.js',
      'lib/types/types.js',
      'lib/types/invariant.js',
    ],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
])
