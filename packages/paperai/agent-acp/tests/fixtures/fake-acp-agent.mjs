import { existsSync, appendFileSync, writeFileSync } from 'node:fs'
import { Readable, Writable } from 'node:stream'
import {
  AgentSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
} from '@agentclientprotocol/sdk'

const logPath = process.env.FAKE_ACP_LOG
const label = process.env.FAKE_ACP_LABEL ?? 'fake'
let currentModel = process.env.FAKE_ACP_MODEL ?? 'fake-alpha'
let currentEffort = 'medium'
const effortId = process.env.FAKE_ACP_EFFORT_ID ?? 'effort'
let fastMode = false
/** Comma-separated config values whose `session/set_config_option` is rejected. */
const rejectedConfigValues = new Set(
  (process.env.FAKE_ACP_REJECT_SET_CONFIG_VALUE ?? '').split(',').filter(value => value.length > 0),
)
let currentMode = label === 'codex'
  ? process.env.INITIAL_AGENT_MODE ?? 'agent'
  : 'default'
let releaseCancelledPrompt
const firstPrompts = new Map()

function log(event, data = {}) {
  if (logPath === undefined) return
  appendFileSync(logPath, `${JSON.stringify({ event, label, ...data })}\n`, 'utf8')
}

function modelOptions() {
  return [...(process.env.FAKE_ACP_PERMISSION_OPTION === '1' ? [{
    type: 'select', id: 'mode', name: 'Mode', category: 'mode', currentValue: currentMode,
    options: modes().availableModes.map(mode => ({ value: mode.id, name: mode.name })),
  }] : []), {
    type: 'select',
    id: 'model',
    name: 'Model',
    category: 'model',
    currentValue: currentModel,
    options: [{
      group: 'fake-models',
      name: 'Fake models',
      options: [
        { value: 'fake-alpha', name: 'Fake Alpha', description: 'Stable fake model' },
        { value: 'fake-beta', name: 'Fake Beta', description: 'Alternate fake model' },
      ],
    }],
  }, {
    // The shape both pinned adapters advertise: a `thought_level` select for
    // the current model and a boolean fast-mode switch (`model_config`).
    type: 'select',
    id: effortId,
    name: 'Effort',
    description: 'Available effort levels for this model',
    ...(process.env.FAKE_ACP_EFFORT_ID === undefined ? { category: 'thought_level' } : {}),
    currentValue: currentEffort,
    options: [
      { value: 'low', name: 'Low' },
      { value: 'medium', name: 'Medium' },
      { value: 'high', name: 'High', description: 'Deeper reasoning' },
    ],
  }, {
    type: 'boolean',
    id: 'fast',
    name: 'Fast mode',
    description: '1.5x speed, increased usage',
    category: 'model_config',
    currentValue: fastMode,
  }]
}

function modes() {
  const omitted = process.env.FAKE_ACP_OMIT_MODE
  const ids = (label === 'codex'
    ? ['read-only', 'agent', 'agent-full-access']
    : ['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions'])
    .filter(id => id !== omitted)
  return {
    currentModeId: currentMode,
    availableModes: ids.map(id => ({ id, name: id })),
  }
}

function makeAgent(connection) {
  return {
    async initialize(params) {
      log('initialize', { cwd: process.cwd(),
        capabilities: params.clientCapabilities,
        environment: {
          openAiApiKey: process.env.OPENAI_API_KEY ?? null,
          anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? null,
          openAiBaseUrl: process.env.OPENAI_BASE_URL ?? null,
          anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL ?? null,
          initialAgentMode: process.env.INITIAL_AGENT_MODE ?? null,
        },
      })
      const diagnosticPath = process.env.FAKE_ACP_DIAGNOSTIC_PATH
      if (diagnosticPath !== undefined) {
        for (const operation of ['read', 'write']) {
          try {
            if (operation === 'read') await connection.readTextFile({ sessionId: 'unowned-diagnostic-session', path: diagnosticPath })
            else await connection.writeTextFile({ sessionId: 'unowned-diagnostic-session', path: diagnosticPath, content: 'probe mutation' })
            log('diagnostic-file-allowed', { operation })
          } catch (error) {
            log('diagnostic-file-denied', { operation, message: String(error) })
          }
        }
        const response = await connection.requestPermission({
          sessionId: 'unowned-diagnostic-session',
          toolCall: { toolCallId: 'diagnostic-edit', title: 'Diagnostic file request', kind: 'edit' },
          options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
        })
        log('diagnostic-permission', { outcome: response.outcome })
        for (const update of [
          { sessionUpdate: 'current_mode_update', currentModeId: currentMode },
          { sessionUpdate: 'config_option_update', configOptions: modelOptions() },
          { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'diagnostic unsolicited message' } },
        ]) await connection.sessionUpdate({ sessionId: 'unowned-diagnostic-session', update })
      }
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: {
          mcpCapabilities: { http: process.env.FAKE_ACP_NO_MCP_HTTP !== '1' },
          loadSession: process.env.FAKE_ACP_NO_LOAD !== '1',
          sessionCapabilities: { ...(process.env.FAKE_ACP_RESUME === '1' ? { resume: {} } : {}), ...(process.env.FAKE_ACP_HISTORY === '1' ? { list: {}, delete: {}, close: {}, additionalDirectories: {} } : {}) },
          promptCapabilities: { image: false, audio: false, embeddedContext: false },
        },
        authMethods: [],
        ...(process.env.FAKE_ACP_STEERING === '1'
          ? { _meta: { steering: { supported: true } } }
          : {}),
      }
    },

    async newSession(params) {
      log('new-session', { cwd: params.cwd, mcpServers: params.mcpServers })
      const startupGate = process.env.FAKE_ACP_STARTUP_GATE_FILE
      while (startupGate !== undefined && existsSync(startupGate)) {
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      const failOnceFile = process.env.FAKE_ACP_FAIL_ONCE_FILE
      if (failOnceFile !== undefined && !existsSync(failOnceFile)) {
        writeFileSync(failOnceFile, 'failed once', 'utf8')
        throw new Error('scripted ACP new-session failure')
      }
      if (process.env.FAKE_ACP_COMMANDS === '1') {
        await connection.sessionUpdate({ sessionId: process.env.FAKE_ACP_SESSION_ID ?? 'fake-external-session', update: {
          sessionUpdate: 'available_commands_update', availableCommands: [
            { name: 'plan', description: 'Native plan', input: null },
            { name: 'review', description: 'Review earlier', input: { hint: ' ' } },
            { name: 'review', description: 'Native review', input: { hint: ' ' } },
          ],
        } })
      }
      return {
        sessionId: process.env.FAKE_ACP_SESSION_ID ?? 'fake-external-session',
        modes: modes(),
        configOptions: modelOptions(),
      }
    },

    async loadSession(params) {
      log('load-session', { sessionId: params.sessionId, cwd: params.cwd, ...(params.additionalDirectories === undefined ? {} : { additionalDirectories: params.additionalDirectories }) })
      while (process.env.FAKE_ACP_LOAD_GATE === '1' && existsSync(`${logPath}.load-gate`)) {
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      if (process.env.FAKE_ACP_FAIL_LOAD === '1') {
        throw new Error('scripted ACP load-session failure')
      }
      if (process.env.FAKE_ACP_HISTORY === '1') await connection.sessionUpdate({ sessionId: params.sessionId, update: { sessionUpdate: 'user_message_chunk', messageId: 'user-original', content: { type: 'text', text: 'Original question' } } })
      await connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'replayed provider history' },
        },
      })
      if (params.sessionId === 'replay-then-fail') throw new Error('replay rejected after notifications')
      return { modes: modes(), configOptions: modelOptions() }
    },

    async closeSession(params) { log('close-session', { sessionId: params.sessionId }); return {} },
    async listSessions(params) {
      log('list-sessions', params)
      return { sessions: [{ sessionId: 'history-one', cwd: params.cwd ?? process.cwd(), title: 'Earlier paper' }] }
    },
    async deleteSession(params) { log('delete-session', params); return {} },

    async resumeSession(params) {
      log('resume-session', { sessionId: params.sessionId, cwd: params.cwd })
      return { modes: modes(), configOptions: modelOptions() }
    },

    async setSessionMode(params) {
      log('set-mode-start', { sessionId: params.sessionId, modeId: params.modeId })
      const rejectionFile = process.env.FAKE_ACP_REJECT_SET_MODE_FILE
      if (process.env.FAKE_ACP_REJECT_SET_MODE === params.modeId
        && (rejectionFile === undefined || existsSync(rejectionFile))) {
        throw new Error(`scripted ACP set-mode rejection for ${params.modeId}`)
      }
      const neverMode = process.env.FAKE_ACP_NEVER_SET_MODE
      const neverOnceFile = process.env.FAKE_ACP_NEVER_SET_MODE_ONCE_FILE
      if (params.modeId === neverMode && (neverOnceFile === undefined || !existsSync(neverOnceFile))) {
        if (neverOnceFile !== undefined) writeFileSync(neverOnceFile, 'stalled once', 'utf8')
        await new Promise(() => {})
      }
      const delayMs = Number(process.env.FAKE_ACP_SET_MODE_DELAY_MS ?? 0)
      if (Number.isFinite(delayMs) && delayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, delayMs))
      }
      currentMode = params.modeId
      log('set-mode', { sessionId: params.sessionId, modeId: params.modeId })
      if (process.env.FAKE_ACP_DELAY_MODE_UPDATE === params.modeId) {
        const updateDelayMs = Number(process.env.FAKE_ACP_MODE_UPDATE_DELAY_MS ?? 0)
        setTimeout(() => {
          void connection.sessionUpdate({
            sessionId: params.sessionId,
            update: { sessionUpdate: 'current_mode_update', currentModeId: params.modeId },
          })
        }, Number.isFinite(updateDelayMs) ? updateDelayMs : 0)
      }
      return {}
    },

    async setSessionConfigOption(params) {
      log('set-config-option', {
        sessionId: params.sessionId,
        configId: params.configId,
        value: params.value,
      })
      const rejectionFile = process.env.FAKE_ACP_REJECT_SET_CONFIG_FILE
      if (rejectionFile !== undefined && existsSync(rejectionFile)) {
        throw new Error(`scripted ACP set-config rejection for ${String(params.value)}`)
      }
      if (process.env.FAKE_ACP_NEVER_SET_CONFIG === String(params.value)) {
        await new Promise(() => {})
      }
      if (rejectedConfigValues.has(String(params.value))) {
        throw new Error(`scripted ACP set-config rejection for value ${String(params.value)}`)
      }
      if (params.configId === effortId) {
        currentEffort = String(params.value)
      } else if (params.configId === 'fast') {
        fastMode = params.value === true
      } else {
        currentModel = String(params.value)
        // Like real adapters, a model switch may re-advertise the effort at the
        // model's own default instead of carrying the previous model's level.
        if (process.env.FAKE_ACP_MODEL_RESETS_EFFORT === '1') currentEffort = 'medium'
      }
      if (process.env.FAKE_ACP_NOTIFY_CONFIG_UPDATES === '1') {
        // Providers may announce the change before answering; the client must
        // not publish such a notification as a settled selection mid-transaction.
        void connection.sessionUpdate({
          sessionId: params.sessionId,
          update: { sessionUpdate: 'config_option_update', configOptions: modelOptions() },
        })
      }
      return { configOptions: modelOptions() }
    },

    async prompt(params) {
      log('prompt', { sessionId: params.sessionId, prompt: params.prompt })
      if (process.env.FAKE_ACP_CRASH_ON_PROMPT === '1') process.exit(7)
      const promptText = params.prompt
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('\n')
      const delayMs = Number(process.env.FAKE_ACP_PROMPT_DELAY_MS ?? 0)
      if (Number.isFinite(delayMs) && delayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, delayMs))
      }
      const promptReleaseFile = process.env.FAKE_ACP_PROMPT_RELEASE_FILE
      while (promptReleaseFile !== undefined && !existsSync(promptReleaseFile)) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      const cancelFinalToolOnceFile = process.env.FAKE_ACP_CANCEL_FINAL_TOOL_ONCE_FILE
      const cancelWithFinalTool = process.env.FAKE_ACP_CANCEL_FINAL_TOOL === '1'
        && (cancelFinalToolOnceFile === undefined || !existsSync(cancelFinalToolOnceFile))
      if (cancelWithFinalTool) {
        if (cancelFinalToolOnceFile !== undefined) {
          writeFileSync(cancelFinalToolOnceFile, 'cancelled once', 'utf8')
        }
        await connection.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Editing before cancellation.' },
          },
        })
        await connection.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'cancel-edit',
            title: 'Edit before cancellation',
            name: 'paperai.edit',
            kind: 'edit',
            status: 'in_progress',
            rawInput: { section: 'introduction' },
          },
        })
        log('cancel-tool-start')
        await new Promise(resolve => { releaseCancelledPrompt = resolve })
        await connection.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'cancel-edit',
            status: 'completed',
            rawOutput: { changedParagraphs: 1 },
            ...(process.env.FAKE_ACP_TOOL_IMAGE === '1' ? { content: [{ type: 'content', content: {
              type: 'image', mimeType: 'image/png',
              data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC',
            } }] } : {}),
          },
        })
        log('cancel-tool-finished')
        return { stopReason: 'cancelled' }
      }
      if (process.env.FAKE_ACP_REQUEST_PERMISSION === '1') {
        const response = await connection.requestPermission({
          sessionId: params.sessionId,
          toolCall: {
            toolCallId: 'permission-call',
            title: 'Modify thesis section',
            name: 'paperai.edit',
            kind: 'edit',
            rawInput: { section: 'introduction' },
          },
          options: [
            { optionId: 'allow-always', name: 'Allow always', kind: 'allow_always' },
            { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'reject-always', name: 'Reject always', kind: 'reject_always' },
            { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
          ],
        })
        log('permission-response', { outcome: response.outcome })
      }

      const readPath = process.env.FAKE_ACP_READ_PATH
      if (readPath !== undefined) {
        try {
          const response = await connection.readTextFile({
            sessionId: params.sessionId,
            path: readPath,
            ...(process.env.FAKE_ACP_READ_LINE === undefined ? {} : { line: Number(process.env.FAKE_ACP_READ_LINE) }),
            ...(process.env.FAKE_ACP_READ_LIMIT === undefined ? {} : { limit: Number(process.env.FAKE_ACP_READ_LIMIT) }),
          })
          log('read-text-file', { path: readPath, content: response.content })
        } catch (error) {
          log('read-text-file-error', {
            path: readPath,
            message: error instanceof Error ? error.message : String(error),
          })
        }
      }

      const writePath = process.env.FAKE_ACP_WRITE_PATH
      if (writePath !== undefined) {
        try {
          await connection.writeTextFile({
            sessionId: params.sessionId,
            path: writePath,
            content: process.env.FAKE_ACP_WRITE_CONTENT_FROM_PROMPT === '1'
              ? promptText
              : process.env.FAKE_ACP_WRITE_CONTENT ?? 'written by fake ACP',
          })
          log('write-text-file', { path: writePath, promptText })
        } catch (error) {
          log('write-text-file-error', {
            path: writePath,
            promptText,
            message: error instanceof Error ? error.message : String(error),
          })
        }
      }

      if (process.env.FAKE_ACP_TERMINAL === '1') {
        const terminal = await connection.createTerminal({ sessionId: params.sessionId, command: process.execPath,
          args: ['-e', 'process.stdout.write("terminal evidence"); process.stderr.write(" stderr")'],
          env: [{ name: 'ACP_TERMINAL_TEST', value: 'true' }], outputByteLimit: 1024,
        })
        const exited = await terminal.waitForExit()
        const output = await terminal.currentOutput()
        await terminal.kill()
        await terminal.release()
        log('terminal-result', { exited, output })
        await connection.sessionUpdate({ sessionId: params.sessionId, update: {
          sessionUpdate: 'tool_call', toolCallId: 'terminal-call', name: 'read_evidence', title: 'Read evidence', kind: 'execute',
          status: 'completed', content: [{ type: 'terminal', terminalId: terminal.id }],
          locations: [{ path: '/paper', line: 2 }],
        } })
        await connection.sessionUpdate({ sessionId: params.sessionId, update: {
          sessionUpdate: 'tool_call', toolCallId: 'diff-call', name: 'update_paper', title: 'Update paper', kind: 'edit', status: 'completed',
          content: [{ type: 'diff', path: '/paper', oldText: 'old', newText: 'new' }],
        } })
      }
      if (process.env.FAKE_ACP_ELICITATION === '1') {
        const response = await connection.createElicitation({ mode: 'form', sessionId: params.sessionId,
          message: 'Paper style', requestedSchema: { type: 'object', required: ['style'],
            properties: { style: { type: 'string' } } },
        })
        log('form-answer', { response })
      }
      if (process.env.FAKE_ACP_EXTENDED_STATE === '1') {
        const updates = [
          { sessionUpdate: 'session_info_update', title: 'Provider title', updatedAt: '2026-09-08T00:00:00Z' },
          { sessionUpdate: 'usage_update', used: 12, size: 100, cost: { amount: 0.05, currency: 'USD' } },
          { sessionUpdate: 'plan_update', plan: { type: 'markdown', planId: 'outline', content: '# Outline' } },
          { sessionUpdate: 'plan_update', plan: { type: 'file', planId: 'file-plan', uri: 'file:///plan.md' } },
          { sessionUpdate: 'plan_update', plan: { type: 'items', planId: 'tasks', entries: [
            { content: 'Read', status: 'pending', priority: 'high' },
          ] } },
          { sessionUpdate: 'plan_removed', planId: 'file-plan' },
          { sessionUpdate: 'compaction_update', compactionId: 'compact', status: 'in_progress' },
          { sessionUpdate: 'compaction_summary_chunk', compactionId: 'compact', content: { type: 'text', text: 'Summary' } },
          { sessionUpdate: 'compaction_update', compactionId: 'compact', status: 'completed',
            summary: [{ type: 'text', text: 'Final summary' }] },
          { sessionUpdate: 'compaction_update', compactionId: 'failed', status: 'failed', error: 'Provider failed' },
        ]
        for (const update of updates) await connection.sessionUpdate({ sessionId: params.sessionId, update })
      }
      if (process.env.FAKE_ACP_TITLE_ECHO === '1') {
        const first = firstPrompts.get(params.sessionId) ?? params.prompt.find(block => block.type === 'text')?.text
        if (first !== undefined) {
          firstPrompts.set(params.sessionId, first)
          const title = first.replace(/\s+/gu, ' ').trim()
          log('title-echo', { title })
          await connection.sessionUpdate({ sessionId: params.sessionId, update: { sessionUpdate: 'session_info_update', title } })
        }
      }
      if (process.env.FAKE_ACP_FAILED_MCP_TOOL === '1') {
        await connection.sessionUpdate({ sessionId: params.sessionId, update: {
          sessionUpdate: 'tool_call', toolCallId: 'failed-mcp-edit', name: 'mcp__paperai__paperai_commit_document',
          title: 'paperai: paperai_commit_document', kind: 'other', status: 'in_progress',
          rawInput: { documentId: 'public-synthetic-document', expectedRevision: 1 },
        } })
        await connection.sessionUpdate({ sessionId: params.sessionId, update: {
          sessionUpdate: 'tool_call_update', toolCallId: 'failed-mcp-edit', status: 'failed',
          rawOutput: { content: [{ type: 'text', text: '{"error":"revision_conflict","detail":"Read the current revision before retrying."}' }], isError: true },
        } })
      }
      const streamTool = process.env.FAKE_ACP_STREAM_TOOL
      if (streamTool !== undefined) {
        const terminalDelta = process.env.FAKE_ACP_STREAM_FORMAT === 'terminal-delta'
        await connection.sessionUpdate({ sessionId: params.sessionId, update: {
          sessionUpdate: 'tool_call', toolCallId: 'streaming-tool', name: 'terminal', title: 'Streaming output', kind: 'execute', status: 'pending',
          ...(terminalDelta ? { content: [{ type: 'terminal', terminalId: 'streaming-tool' }], _meta: { terminal_info: { terminal_id: 'streaming-tool' } } } : {}),
        } })
        await connection.sessionUpdate({ sessionId: params.sessionId, update: {
          sessionUpdate: 'tool_call_update', toolCallId: 'streaming-tool', status: 'in_progress',
        } })
        let output = ''
        if (terminalDelta) for (const delta of [{ terminal_id: 'another-call', data: 'unrelated-output' }, { terminal_id: 'streaming-tool', data: 123 }]) {
          await connection.sessionUpdate({ sessionId: params.sessionId, update: {
            sessionUpdate: 'tool_call_update', toolCallId: 'streaming-tool', _meta: { terminal_output_delta: delta },
          } })
        }
        for (let index = 0; index < Number(process.env.FAKE_ACP_STREAM_UPDATES ?? 400); index++) {
          const delta = `${String(index).padStart(3, '0')} ${'x'.repeat(250)}\n`
          output += delta
          await connection.sessionUpdate({ sessionId: params.sessionId, update: {
            sessionUpdate: 'tool_call_update', toolCallId: 'streaming-tool',
            ...(terminalDelta ? { _meta: { terminal_output_delta: { terminal_id: 'streaming-tool', data: delta } } } : { rawOutput: output }),
          } })
        }
        while (process.env.FAKE_ACP_STREAM_GATE_FILE !== undefined && existsSync(process.env.FAKE_ACP_STREAM_GATE_FILE)) {
          await new Promise(resolve => setTimeout(resolve, 10))
        }
        if (streamTool === 'completed') await connection.sessionUpdate({ sessionId: params.sessionId, update: {
          sessionUpdate: 'tool_call_update', toolCallId: 'streaming-tool', status: 'completed',
        } })
      }
      if (process.env.FAKE_ACP_FULL_UPDATES === '1') {
        await connection.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Revised ' },
          },
        })
        await connection.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: 'Checking evidence.' },
          },
        })
        await connection.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'edit-1',
            title: 'Edit introduction',
            name: 'paperai.edit',
            kind: 'edit',
            status: 'in_progress',
            rawInput: { section: 'introduction' },
          },
        })
        await connection.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'plan',
            entries: [
              { content: 'Inspect requirements', priority: 'high', status: 'completed' },
              { content: 'Revise introduction', priority: 'high', status: 'in_progress' },
              { content: 'Revise introduction', priority: 'low', status: 'pending' },
              { content: '  ', priority: 'low', status: 'pending' },
            ],
          },
        })
        await connection.sessionUpdate({
          sessionId: params.sessionId,
          update: { sessionUpdate: 'usage_update', used: 512, size: 131072 },
        })
        await connection.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'edit-1',
            status: 'completed',
            rawOutput: { changedParagraphs: 1 },
          },
        })
        await connection.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'introduction.' },
          },
        })
      } else {
        await connection.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: process.env.FAKE_ACP_TEXT ?? 'fake answer' },
          },
        })
      }

      return {
        stopReason: process.env.FAKE_ACP_STOP_REASON ?? 'end_turn',
        usage: {
          totalTokens: 21,
          inputTokens: 13,
          outputTokens: 8,
          thoughtTokens: 3,
          cachedReadTokens: 2,
          cachedWriteTokens: 1,
        },
      }
    },

    cancel(params) {
      log('cancel', { sessionId: params.sessionId })
      releaseCancelledPrompt?.()
      releaseCancelledPrompt = undefined
    },

    extMethod(method, params) {
      if (method !== '_session/steering') return {}
      log('steer', { sessionId: params.sessionId, prompt: params.prompt })
      return { outcome: process.env.FAKE_ACP_STEERING_OUTCOME ?? 'injected' }
    },

    authenticate() {},
  }
}

new AgentSideConnection(
  makeAgent,
  ndJsonStream(
    Writable.toWeb(process.stdout),
    Readable.toWeb(process.stdin),
  ),
)
