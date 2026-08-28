/** Package-owned invariant companion for the OfficeCLI Provider. */

import { lstat } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { LEGACY_DOC_CONVERTER_ASSET } from './legacy-doc.ts'

const PACKAGE_NAME = '@paperai/document-engine-officecli'
export const name = 'paperai-document-engine-officecli-invariant'
export const inject = ['invariants']

/**
 * Inspect one converter asset path without publishing a second source of truth.
 * @param path - expected packaged PowerShell file.
 * @returns undefined for a regular non-link file, otherwise an invariant diagnostic.
 */
export async function converterAssetIssue(path: string): Promise<string | undefined> {
  try {
    const metadata = await lstat(path)
    return metadata.isFile() && !metadata.isSymbolicLink()
      ? undefined
      : `legacy Word converter asset is not a regular file: ${path}`
  } catch (error) {
    return `legacy Word converter asset is unavailable at '${path}': ${String(error)}`
  }
}

/**
 * Enforce the converter asset relationship for one path.
 * @param path - expected packaged PowerShell file.
 * @param fail - package-attributed invariant reporter.
 */
export async function verifyConverterAsset(path: string, fail: (message: string) => never): Promise<void> {
  const issue = await converterAssetIssue(path)
  if (issue !== undefined) fail(issue)
}

const install: InvariantInstaller = async (_ctx, fail) => {
  await verifyConverterAsset(LEGACY_DOC_CONVERTER_ASSET, fail)
}

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
