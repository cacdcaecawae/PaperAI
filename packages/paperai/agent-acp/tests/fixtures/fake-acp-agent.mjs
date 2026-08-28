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
  }]
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

    newSession(params) {
      log('new-session', { cwd: params.cwd, mcpServers: params.mcpServers })
      const failOnceFile = process.env.FAKE_ACP_FAIL_ONCE_FILE
      if (failOnceFile !== undefined && !existsSync(failOnceFile)) {
        writeFileSync(failOnceFile, 'failed once', 'utf8')
        throw new Error('scripted ACP new-session failure')
      }
      return {
        sessionId: process.env.FAKE_ACP_SESSION_ID ?? 'fake-external-session',
        configOptions: modelOptions(),
      }
    },

    async loadSession(params) {
      log('load-session', { sessionId: params.sessionId, cwd: params.cwd })
      await connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'replayed provider history' },
        },
      })
      return { configOptions: modelOptions() }
    },

    setSessionConfigOption(params) {
      log('set-config-option', {
        sessionId: params.sessionId,
        configId: params.configId,
        value: params.value,
      })
      currentModel = String(params.value)
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
