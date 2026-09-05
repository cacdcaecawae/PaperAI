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
let fastMode = false
/** Comma-separated config values whose `session/set_config_option` is rejected. */
const rejectedConfigValues = new Set(
  (process.env.FAKE_ACP_REJECT_SET_CONFIG_VALUE ?? '').split(',').filter(value => value.length > 0),
)
let currentMode = label === 'codex'
  ? process.env.INITIAL_AGENT_MODE ?? 'agent'
  : 'default'
let releaseCancelledPrompt

function log(event, data = {}) {
  if (logPath === undefined) return
  appendFileSync(logPath, `${JSON.stringify({ event, label, ...data })}\n`, 'utf8')
}

function modelOptions() {
  return [{
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
    id: 'effort',
    name: 'Effort',
    description: 'Available effort levels for this model',
    category: 'thought_level',
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
    initialize(params) {
      log('initialize', {
        capabilities: params.clientCapabilities,
        environment: {
          openAiApiKey: process.env.OPENAI_API_KEY ?? null,
          anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? null,
          openAiBaseUrl: process.env.OPENAI_BASE_URL ?? null,
          anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL ?? null,
          initialAgentMode: process.env.INITIAL_AGENT_MODE ?? null,
        },
      })
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: true,
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
      return {
        sessionId: process.env.FAKE_ACP_SESSION_ID ?? 'fake-external-session',
        modes: modes(),
        configOptions: modelOptions(),
      }
    },

    async loadSession(params) {
      log('load-session', { sessionId: params.sessionId, cwd: params.cwd })
      if (process.env.FAKE_ACP_FAIL_LOAD === '1') {
        throw new Error('scripted ACP load-session failure')
      }
      await connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'replayed provider history' },
        },
      })
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
      if (params.configId === 'effort') {
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
