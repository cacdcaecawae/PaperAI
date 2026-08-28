/** Remove only the disposable VitePress build tree before a documentation build. */

import { rmSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'

const repositoryRoot = resolve(import.meta.dirname, '..')
const websiteRoot = resolve(repositoryRoot, 'website')
const outputRoot = resolve(websiteRoot, '.dist')

if (dirname(outputRoot) !== websiteRoot || basename(outputRoot) !== '.dist') {
  throw new Error(`refusing to clean unexpected documentation output ${JSON.stringify(outputRoot)}`)
}

rmSync(outputRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
console.log(`clean-doc-site-output: removed ${outputRoot}`)
