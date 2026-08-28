/** Pinned HIT master's-degree template-pack contribution. */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import {
  TemplatePackId,
  TemplatePackMemberId,
} from '@paperai/template-service'
import type {
  TemplatePackManifest,
  TemplatePackMember,
} from '@paperai/template-service'

const ASSET_ROOT = fileURLToPath(new URL('../assets/', import.meta.url))
const MANIFEST_PATH = fileURLToPath(new URL('../assets/manifest.json', import.meta.url))
const RoleSchema = z.enum(['manuscript', 'proposal', 'midterm', 'final', 'other'])
const UsageSchema = z.enum(['form-template', 'format-reference'])
const AssetSchema = z.object({
  file: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  size: z.number().int().nonnegative(),
})
const ManifestSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  version: z.string().min(1),
  sourceLabel: z.string().min(1),
  members: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1),
    appliesToRoles: z.array(RoleSchema).min(1),
    usage: UsageSchema,
    sourceVersion: z.string().min(1),
    source: AssetSchema.extend({ originalFileName: z.string().min(1) }),
    normalized: AssetSchema,
  })).min(1),
})

/** Cordis plugin name. */
export const name = 'paperai-template-pack-hit'
/** Template registry required before this pack can contribute. */
export const inject = ['paperTemplates']

/** Validated, immutable HIT pack manifest with package-local asset paths. */
export const HIT_TEMPLATE_PACK: TemplatePackManifest = loadManifest()

/**
 * Register the HIT pack for this plugin fiber's lifetime.
 * @param ctx - Cordis context carrying the PaperAI template registry.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.paperTemplates.registerPack(HIT_TEMPLATE_PACK), 'paperai-template-pack-hit.register')
}

function loadManifest(): TemplatePackManifest {
  const root = ManifestSchema.parse(JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')))
  const members = root.members.map(parseMember)
  return Object.freeze({
    id: TemplatePackId(root.id),
    name: root.name,
    description: root.description,
    version: root.version,
    sourceLabel: root.sourceLabel,
    members: Object.freeze(members),
  })
}

function parseMember(member: z.infer<typeof ManifestSchema>['members'][number]): TemplatePackMember {
  return Object.freeze({
    id: TemplatePackMemberId(member.id),
    name: member.name,
    description: member.description,
    appliesToRoles: Object.freeze(member.appliesToRoles),
    usage: member.usage,
    sourceVersion: member.sourceVersion,
    source: Object.freeze({
      path: join(ASSET_ROOT, member.source.file),
      originalFileName: member.source.originalFileName,
      sha256: member.source.sha256,
      size: member.source.size,
    }),
    normalized: Object.freeze({
      path: join(ASSET_ROOT, member.normalized.file),
      sha256: member.normalized.sha256,
      size: member.normalized.size,
    }),
  })
}
