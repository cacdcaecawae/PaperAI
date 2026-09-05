/** Loader seat for the browser-only PaperAI workbench plugin. */

import type { Context } from '@deepseek-ai/cordis'
import { resolvePreviewBudget, type Config } from './config.ts'

export type { Config } from './config.ts'

/** Validate browser resource limits before the Loader publishes the client configuration. */
export function apply(_ctx: Context, config: Config = {}): void { resolvePreviewBudget(config) }
