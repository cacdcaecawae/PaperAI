/** Current ACP options and provider-owned session status in the existing conversation header. */

import { useEffect, useState } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { AcpSessionControlState } from './session-controller.ts'
import type { AcpSettingsState } from './controller.ts'
import css from './SettingsSection.module.css'

/** Runtime-bound controls and shared instance preferences. */
export interface AcpSessionInjected {
  hooks: { acpSession: HostObservable<AcpSessionControlState>; acpPreferences: HostObservable<AcpSettingsState> }
  load: () => Promise<void>
  select: (option: string, value: string | boolean) => Promise<void>
  favorite: (provider: string, model: string) => Promise<void>
}

/** ACP contribution to a single conversation's header. */
export type AcpSessionProps = PropsRuntime<'conversation.session.header.actions'> & InjectFace<AcpSessionInjected>

/**
 * Show negotiated controls, searched models, and durable provider status for this conversation.
 * @param props - owning session and injected controls.
 * @returns header entry and its options dialog, or null for native DSH.
 */
export function AcpSessionControls({
  sessionId,
  useSessions,
  useAcpSession,
  useAcpPreferences,
  load,
  select,
  favorite,
}: AcpSessionProps) {
  const state = useAcpSession(value => value)
  const preferences = useAcpPreferences(value => value)
  const preset = useSessions(value => value.byId[sessionId]?.agentPreset)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [customModel, setCustomModel] = useState('')
  useEffect(() => {
    void load()
  }, [load, preset])
  const details = state.details
  if (details === null) return null
  const favorites = preferences.favorites[details.provider] ?? []
  return (
    <>
      <button
        type="button"
        className={css.sessionButton}
        aria-label={`${details.name} ACP 会话选项`}
        onClick={() => {
          setOpen(true)
          void load()
        }}
      >
        {details.connected ? '已连接' : '未连接'} · ACP 选项
      </button>
      <Modal
        open={open}
        onClose={() => {
          setOpen(false)
        }}
        title={`${details.name} · 会话选项`}
        closeLabel="关闭 ACP 会话选项"
        className={css.modal ?? ''}
      >
        <div className={css.form}>
          <p className={css.note}>
            当前渠道：{details.name} · {details.connected ? '已连接' : '未连接'} · 外部会话{' '}
            {details.externalSessionId ?? '尚未建立'}
          </p>
          {state.error !== null && (
            <p role="alert" className={css.error}>
              {state.error}
            </p>
          )}
          {preferences.error !== null && (
            <p role="alert" className={css.error}>
              {preferences.error}
            </p>
          )}
          <button
            type="button"
            disabled={state.loading}
            onClick={() => {
              void load()
            }}
          >
            刷新选项
          </button>
          {details.options.map(option =>
            option.category === 'model' ? (
              <section key={option.id}>
                <label>
                  {option.name}
                  <input
                    aria-label="搜索 ACP 模型"
                    placeholder="搜索模型名称或 ID"
                    value={query}
                    onChange={(event) => {
                      setQuery(event.target.value)
                    }}
                  />
                </label>
                <div className={css.models}>
                  {[...option.choices]
                    .sort((a, b) => Number(favorites.includes(b.value)) - Number(favorites.includes(a.value)))
                    .filter(choice => `${choice.name} ${choice.value}`.toLowerCase().includes(query.toLowerCase()))
                    .map(choice => (
                      <div className={css.history} key={choice.value}>
                        <button
                          type="button"
                          disabled={state.busy || !details.connected}
                          aria-pressed={option.value === choice.value}
                          onClick={() => {
                            void select(option.id, choice.value)
                          }}
                        >
                          {option.value === choice.value ? '✓ ' : ''}
                          {choice.name}
                          <small>{choice.value}</small>
                        </button>
                        <button
                          type="button"
                          disabled={!preferences.writable}
                          aria-label={`${favorites.includes(choice.value) ? '取消收藏' : '收藏'} ${choice.name}`}
                          onClick={() => {
                            void favorite(details.provider, choice.value)
                          }}
                        >
                          {favorites.includes(choice.value) ? '★' : '☆'}
                        </button>
                      </div>
                    ))}
                </div>
                <form
                  className={css.toolbar}
                  onSubmit={(event) => {
                    event.preventDefault()
                    void select(option.id, customModel.trim())
                  }}
                >
                  <input
                    aria-label="自定义模型 ID"
                    value={customModel}
                    onChange={(event) => {
                      setCustomModel(event.target.value)
                    }}
                    placeholder="输入模型 ID，由渠道验证"
                  />
                  <button type="submit" disabled={state.busy || !details.connected || customModel.trim() === ''}>
                    应用模型
                  </button>
                </form>
              </section>
            ) : (
              <label key={option.id}>
                {option.name}
                {typeof option.value === 'boolean' ? (
                  <input
                    type="checkbox"
                    disabled={state.busy || !option.editable || !details.connected}
                    checked={option.value}
                    onChange={(event) => {
                      void select(option.id, event.target.checked)
                    }}
                  />
                ) : (
                  <select
                    disabled={state.busy || !option.editable || !details.connected}
                    value={option.value}
                    onChange={(event) => {
                      void select(option.id, event.target.value)
                    }}
                  >
                    {!option.choices.some(choice => choice.value === option.value) && <option>{option.value}</option>}
                    {option.choices.map(choice => (
                      <option key={choice.value} value={choice.value}>
                        {choice.name}
                      </option>
                    ))}
                  </select>
                )}
                <small>{option.editable ? option.description : '由当前会话的权限设置控制'}</small>
              </label>
            ),
          )}
          {details.state.usage !== null && (
            <p>
              上下文 {details.state.usage.used} / {details.state.usage.size}
              {details.state.usage.cost === null
                ? ''
                : ` · 累计费用 ${details.state.usage.cost.amount} ${details.state.usage.cost.currency}`}
            </p>
          )}
          {details.state.stopReason !== null && <p>本轮停止原因：{details.state.stopReason}</p>}
          {details.state.plans.map(plan => (
            <details key={plan.id}>
              <summary>计划 · {plan.id}</summary>
              {plan.text !== '' && <pre>{plan.text}</pre>}
              <ul>
                {plan.entries.map((entry, index) => (
                  <li key={index}>
                    {entry.status === 'completed' ? '✓ ' : entry.status === 'in_progress' ? '进行中 · ' : ''}
                    {entry.content}
                  </li>
                ))}
              </ul>
            </details>
          ))}
          {details.state.compactions.map(compaction => (
            <details key={compaction.id}>
              <summary>上下文压缩 · {compaction.status}</summary>
              {compaction.error !== null && <p role="alert">{compaction.error}</p>}
              <pre>{compaction.summary}</pre>
            </details>
          ))}
          {details.state.commands.length > 0 && (
            <details>
              <summary>原生命令</summary>
              <p>在输入框输入 /acp- 可选择渠道命令。</p>
              <ul>
                {details.state.commands.map(command => (
                  <li key={command.name}>
                    /{command.name} · {command.description}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </Modal>
    </>
  )
}
