/**
 * PaperAI occupants for the generic browser-brand slots, plus the product's
 * vocabulary overlay: what DSH calls a workspace is a project here. Colors
 * stay the shipped DSH theme; only the mark and the wordmark are PaperAI's.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-agent-preset/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@paperai/ui-workbench/client'
import {
  ClaudeAgentMark,
  CodexAgentMark,
  PaperAIBrandMark,
  PaperAIBrandName,
  DshAgentMark,
} from './PaperAIBrand.tsx'

/** Required services: the UI slot registry and the locale registry the vocabulary overlay rides. */
export const inject = ['slots', 'locale']

/**
 * The project vocabulary: every shell string that names a workspace, restated
 * for a product whose unit of work is a thesis project. Keys not listed keep
 * the DSH copy.
 */
export const PROJECT_COPY = {
  workspace: {
    zh: {
      'section.workspaces': '项目',
      'groupBy.workspace': '按项目',
      'workspace.add': '添加项目',
      'workspace.back': '返回项目列表',
      'workspace.detail.aria': '项目详情',
      'workspace.sessions.aria': '项目会话',
      'menu.addWorkspace': '添加项目…',
      'picker.loading': '正在加载项目…',
      'conflict.named': '已存在名为“{name}”的项目。',
      'rename.workspace.title': '重命名项目',
      'field.workspaceName': '项目名称',
      'delete.workspace': '删除项目',
      'delete.desc': '将把“{name}”从项目列表中移除。文件夹、文档与会话记录都会保留，其会话将显示在“未分组”下。',
      'delete.pending': '正在删除项目…',
      'actions.workspace.aria': '项目“{name}”的操作',
    },
    en: {
      'section.workspaces': 'Projects',
      'groupBy.workspace': 'Project',
      'workspace.add': 'Add project',
      'workspace.back': 'Back to projects',
      'workspace.detail.aria': 'Project details',
      'workspace.sessions.aria': 'Project sessions',
      'menu.addWorkspace': 'Add project…',
      'picker.loading': 'Loading projects…',
      'conflict.named': 'A project named “{name}” already exists.',
      'rename.workspace.title': 'Rename project',
      'field.workspaceName': 'Project name',
      'delete.workspace': 'Delete project',
      'delete.desc': 'This removes “{name}” from the project list. The folder, its documents, and session logs will be kept. Its sessions will appear under Ungrouped.',
      'delete.pending': 'Deleting project…',
      'actions.workspace.aria': 'Project actions for {name}',
    },
  },
  conversation: {
    zh: {
      'placeholder.workspace': '选择一个项目开始',
      'hero.chooseWorkspace': '选择项目',
    },
    en: {
      'placeholder.workspace': 'Choose a project to start',
      'hero.chooseWorkspace': 'Choose project',
    },
  },
} as const

/**
 * Fill every shipped brand slot and overlay the project vocabulary.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.override('workspace', PROJECT_COPY.workspace), 'paperai-brand: project vocabulary')
  ctx.effect(() => ctx.locale.override('conversation', PROJECT_COPY.conversation), 'paperai-brand: hero vocabulary')
  ctx.slots.inject('sidebar.brand.mark', () =>
    ctx.slots.inject('sidebar.brand.name', () =>
      ctx.slots.inject('conversation.hero.brand.mark', function* () {
        yield ctx.slots.register({ name: 'sidebar.brand.mark' }, PaperAIBrandMark)
        yield ctx.slots.register({ name: 'sidebar.brand.name' }, PaperAIBrandName)
        yield ctx.slots.register({ name: 'conversation.hero.brand.mark' }, PaperAIBrandMark)
      })))
  // The start page (ui-workbench) declares its own mark seat; the same mark fills it.
  ctx.slots.inject('paperai.start.mark', () =>
    ctx.slots.register({ name: 'paperai.start.mark' }, PaperAIBrandMark))
  ctx.slots.inject('conversation.hero.agentPreset.mark', function* () {
    yield ctx.slots.register({ name: 'conversation.hero.agentPreset.mark', key: 'codex' }, CodexAgentMark)
    yield ctx.slots.register({ name: 'conversation.hero.agentPreset.mark', key: 'claude' }, ClaudeAgentMark)
    yield ctx.slots.register({ name: 'conversation.hero.agentPreset.mark', key: 'dsh' }, DshAgentMark)
  })
}
