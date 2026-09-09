/** Unified ACP directory and instance editor inside the existing settings shell. */

import { useEffect, useState } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from './brand-slot.ts'
import type { AcpSettingsState, ChannelDraft } from './controller.ts'
import type { AcpHistoryEntry, AcpManagementRequest } from '@paperai/agent-acp/diagnostic-types'
import css from './SettingsSection.module.css'

/** Host-backed observations and actions supplied by the ACP plugin. */
export interface AcpSettingsInjected {
  hooks: { acp: HostObservable<AcpSettingsState> }
  load: () => Promise<void>
  probe: (id?: string) => Promise<void>
  cancel: (id: string) => Promise<void>
  edit: (id: string) => void
  updateDraft: (patch: Partial<ChannelDraft>) => void
  cancelEdit: () => void
  save: () => Promise<void>
  setDefault: (id: string) => Promise<void>
  manage: (id: string, action: AcpManagementRequest) => Promise<void>
  install: (id: string, action: 'install' | 'uninstall') => Promise<void>
  importHistory: (id: string, history: AcpHistoryEntry) => Promise<boolean>
}

/** Settings section owner and injected actions. */
export type AcpSettingsProps = PropsRuntime<'settings.section'>
  & PropsRenderSlots<'paperai.acp.channel.mark'>
  & InjectFace<AcpSettingsInjected>

/** Render the complete channel directory without switching the active conversation. */
export function AcpSettingsSection({
  useAcp,
  load,
  probe,
  cancel,
  edit,
  updateDraft,
  cancelEdit,
  save,
  setDefault,
  manage,
  install,
  importHistory,
  close,
  renderSlot,
}: AcpSettingsProps) {
  const state = useAcp(value => value)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<{
    id: string
    kind: 'install' | 'uninstall' | 'logout' | 'delete'
    sessionId?: string
  } | null>(null)
  const [historyCwd, setHistoryCwd] = useState('')
  const [routing, setRouting] = useState<{
    id: string
    providerId: string
    apiType: string
    baseUrl: string
    headers: string
    error: string | null
  } | null>(null)
  useEffect(() => {
    void load()
  }, [load])
  const draft = state.draft
  return (
    <section className={css.page} aria-label="Agent">
      <div className={css.group}>
        <div className={css.groupLabel}>
          <span>Agent</span>
          <span className={css.actions}>
            <button
              type="button"
              disabled={state.loading}
              onClick={() => {
                void load()
              }}
            >
              刷新安装状态
            </button>
            <button
              type="button"
              disabled={state.busy.length > 0}
              onClick={() => {
                void probe()
              }}
            >
              一键检测
            </button>
          </span>
        </div>
        {state.error !== null && (
          <p role="alert" className={css.error}>
            {state.error}
          </p>
        )}
        <div className={css.card}>
          {state.entries.map((entry) => {
            const diagnostic = entry.diagnostic
            const nextCursor = state.management[entry.id]?.nextCursor
            const busy = state.busy.includes(entry.id) || entry.busy !== null
            const missing = entry.source !== 'remote' && entry.adapter === null
            const status = busy && entry.busy !== 'connecting'
              ? entry.busy === 'install'
                ? '安装中'
                : entry.busy === 'authenticate'
                  ? '认证中'
                  : entry.busy === 'probe'
                    ? '检测中'
                    : '处理中'
              : missing
                ? '未安装'
                : diagnostic.status === 'ready'
                  ? '检测通过'
                  : diagnostic.status === 'error'
                    ? '检测失败'
                    : '待检测'
            const usage = !state.usageKnown
              ? '使用情况未知'
              : entry.connected
                ? '正在使用'
                : entry.startup !== null
                  ? '连接中'
                  : '未使用'
            return (
              <article key={entry.id}>
                <div className={css.row}>
                  <span className={css.mark} aria-hidden="true">
                    {renderSlot('paperai.acp.channel.mark', {
                      presetId: entry.id,
                      size: 20,
                    }, { entryKey: entry.id })}
                  </span>
                  <button
                    type="button"
                    className={css.identity}
                    aria-expanded={expanded === entry.id}
                    onClick={() => {
                      setExpanded(expanded === entry.id ? null : entry.id)
                    }}
                  >
                    <span>
                      <strong>{entry.name}</strong>
                      {state.defaultProvider === entry.id && <span className={css.badge}>默认</span>}
                      {!entry.enabled && <span className={css.badge}>未启用</span>}
                    </span>
                    <small>
                      {entry.host} · {entry.command} {entry.args.join(' ')}
                    </small>
                  </button>
                  <div className={css.channelState}>
                    <span className={css.status} data-ready={status === '检测通过'} data-error={status === '检测失败'}>
                      {status}
                    </span>
                    <span className={css.status} data-ready={state.usageKnown && entry.connected}>
                      {usage}
                    </span>
                  </div>
                  <div className={css.actions}>
                    {busy ? (
                      <button
                        type="button"
                        onClick={() => {
                          void cancel(entry.id)
                        }}
                      >
                        取消
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={missing}
                        onClick={() => {
                          void probe(entry.id)
                        }}
                      >
                        检测
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={!state.writable}
                      onClick={() => {
                        edit(entry.id)
                      }}
                    >
                      配置
                    </button>
                  </div>
                </div>
                {expanded === entry.id && (
                  <div className={css.details}>
                    <dl>
                      <dt>运行主机</dt>
                      <dd>{entry.host}</dd>
                      <dt>CLI</dt>
                      <dd>{entry.cli ?? (entry.source === 'remote' ? '远程路径未报告' : '未在此主机发现')}</dd>
                      <dt>检测 / 操作</dt>
                      <dd>
                        {status}
                        {status === '检测通过' && (
                          <>
                            {' · '}
                            {diagnostic.stage === 'prompt' ? '模型请求成功' : diagnostic.stage === 'session' ? '会话已就绪' : '握手通过'}
                          </>
                        )}
                      </dd>
                      <dt>会话使用</dt>
                      <dd>正在使用表示有会话已连接此渠道；不同会话可以同时使用不同渠道。</dd>
                      {entry.startup !== null && (
                        <>
                          <dt>连接阶段</dt>
                          <dd>
                            {(
                              {
                                spawn: '启动进程',
                                initialize: 'ACP 握手',
                                load: '恢复会话',
                                new: '创建会话',
                                permissions: '同步权限',
                              } as Record<string, string>
                            )[entry.startup.stage] ?? entry.startup.stage}{' '}
                            · {entry.startup.elapsedMs} ms
                          </dd>
                        </>
                      )}
                      <dt>ACP 适配器</dt>
                      <dd>{entry.adapter ?? '未发现'}</dd>
                      <dt>安装来源</dt>
                      <dd>
                        {entry.source === 'remote'
                          ? 'SSH 远程主机'
                          : entry.source === 'bundled'
                            ? '随 PaperAI 发布'
                            : entry.source === 'managed'
                              ? 'PaperAI 管理'
                              : '用户已有 / 自定义命令'}
                      </dd>
                      <dt>版本</dt>
                      <dd>
                        适配器 {diagnostic.adapterVersion ?? '—'} · Agent {diagnostic.agentVersion ?? '—'}
                      </dd>
                      <dt>最近检测</dt>
                      <dd>
                        {diagnostic.checkedAt === null ? '尚未检测' : new Date(diagnostic.checkedAt).toLocaleString()}
                        {diagnostic.elapsedMs === null ? '' : ` · ${diagnostic.elapsedMs} ms`}
                      </dd>
                      <dt>登录</dt>
                      <dd>
                        {entry.login ?? '按渠道文档配置环境变量或登录'}
                        {entry.documentation !== null && (
                          <>
                            {' '}
                            ·{' '}
                            <a href={entry.documentation} target="_blank" rel="noreferrer">
                              渠道文档
                            </a>
                          </>
                        )}
                      </dd>
                    </dl>
                    <p className={css.note}>握手检测不发送模型请求。登录状态、模型访问权限与余额以实际对话为准。</p>
                    {diagnostic.error !== null && (
                      <p role="alert" className={css.error}>
                        {diagnostic.error === 'authentication'
                          ? '需要登录或检查凭据'
                          : diagnostic.error === 'timeout'
                            ? '检测超时，可重试或检查命令'
                            : diagnostic.error === 'unavailable'
                              ? '可执行文件不可用'
                              : 'ACP 协议初始化失败'}
                      </p>
                    )}
                    {diagnostic.models.length > 0 && (
                      <p>最近会话的模型：{diagnostic.models.map(model => model.name).join('、')}</p>
                    )}
                    <div className={css.actions}>
                      {entry.installable && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            setConfirm({ id: entry.id, kind: 'install' })
                          }}
                        >
                          {entry.source === 'managed' ? '更新托管安装' : '安装到 PaperAI'}
                        </button>
                      )}
                      {entry.source === 'managed' && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            setConfirm({ id: entry.id, kind: 'uninstall' })
                          }}
                        >
                          卸载托管安装
                        </button>
                      )}
                      {diagnostic.authMethods
                        ?.filter(method => method.type === 'agent')
                        .map(method => (
                          <button
                            type="button"
                            key={method.id}
                            disabled={busy}
                            title={method.description ?? undefined}
                            onClick={() => {
                              void manage(entry.id, { kind: 'authenticate', methodId: method.id })
                            }}
                          >
                            {method.name}
                          </button>
                        ))}
                      {diagnostic.capabilities?.logout && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            setConfirm({ id: entry.id, kind: 'logout' })
                          }}
                        >
                          退出渠道登录
                        </button>
                      )}
                      {diagnostic.capabilities?.providers && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            void manage(entry.id, { kind: 'providers' })
                          }}
                        >
                          模型服务商
                        </button>
                      )}
                    </div>
                    {entry.output !== null && (
                      <details open={busy}>
                        <summary>操作输出</summary>
                        <pre>{entry.output}</pre>
                      </details>
                    )}
                    {diagnostic.capabilities?.list && (
                      <details>
                        <summary>渠道中的历史会话</summary>
                        <div className={css.toolbar}>
                          <input
                            aria-label={`${entry.name} 历史工作目录`}
                            value={historyCwd}
                            onChange={(event) => {
                              setHistoryCwd(event.target.value)
                            }}
                            placeholder="全部目录，或输入此主机上的绝对路径"
                          />
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => {
                              void manage(entry.id, {
                                kind: 'history',
                                ...(historyCwd.trim() === '' ? {} : { cwd: historyCwd.trim() }),
                              })
                            }}
                          >
                            读取历史
                          </button>
                        </div>
                        {state.management[entry.id]?.sessions?.map(session => (
                          <div className={css.history} key={session.sessionId}>
                            <div>
                              <strong>{session.title ?? session.sessionId}</strong>
                              <small>
                                {session.cwd} · {session.updatedAt ?? '时间未报告'}
                              </small>
                            </div>
                            <button
                              type="button"
                              disabled={busy || !entry.enabled || diagnostic.capabilities?.load !== true}
                              onClick={() => {
                                void importHistory(entry.id, session).then((opened) => {
                                  if (opened) close()
                                })
                              }}
                            >
                              导入并打开
                            </button>
                            {diagnostic.capabilities?.delete && (
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => {
                                  setConfirm({ id: entry.id, kind: 'delete', sessionId: session.sessionId })
                                }}
                              >
                                删除外部历史
                              </button>
                            )}
                          </div>
                        ))}
                        {nextCursor != null && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => {
                              void manage(entry.id, {
                                kind: 'history',
                                cursor: nextCursor,
                                ...(historyCwd.trim() === '' ? {} : { cwd: historyCwd.trim() }),
                              })
                            }}
                          >
                            加载更多
                          </button>
                        )}
                      </details>
                    )}
                    {state.management[entry.id]?.providers?.map(provider => (
                      <div className={css.history} key={provider.id}>
                        <div>
                          <strong>
                            {provider.id}
                            {provider.required ? ' · 必需' : ''}
                          </strong>
                          <small>
                            {provider.current === null
                              ? '未启用'
                              : `${provider.current.apiType} · ${provider.current.baseUrl}`}
                          </small>
                        </div>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            setRouting({
                              id: entry.id,
                              providerId: provider.id,
                              apiType: provider.current?.apiType ?? provider.supported[0] ?? '',
                              baseUrl: provider.current?.baseUrl ?? '',
                              headers: '{}',
                              error: null,
                            })
                          }}
                        >
                          设置
                        </button>
                        {!provider.required && provider.current !== null && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => {
                              void manage(entry.id, { kind: 'disable-provider', providerId: provider.id })
                            }}
                          >
                            禁用服务商
                          </button>
                        )}
                      </div>
                    ))}
                    {diagnostic.capabilities !== undefined && (
                      <details>
                        <summary>协议能力</summary>
                        <p>
                          {Object.entries(diagnostic.capabilities)
                            .filter(([, enabled]) => enabled)
                            .map(
                              ([name]) =>
                                ({
                                  load: '加载历史',
                                  resume: '恢复会话',
                                  list: '历史列表',
                                  fork: '原生分叉',
                                  close: '关闭会话',
                                  delete: '删除历史',
                                  additionalDirectories: '额外目录',
                                  image: '图片输入',
                                  audio: '音频输入',
                                  embeddedContext: '嵌入资源',
                                  mcpHttp: 'MCP HTTP',
                                  mcpSse: 'MCP SSE',
                                  providers: '模型服务商配置',
                                  logout: '退出登录',
                                })[name] ?? name,
                            )
                            .join(' · ') || '仅 ACP 基础会话能力'}
                        </p>
                      </details>
                    )}
                  </div>
                )}
              </article>
            )
          })}
          {state.entries.length === 0 && <p className={css.note}>{state.loading ? '正在读取渠道…' : '没有可用的 Agent'}</p>}
        </div>
      </div>
      <div className={css.group}>
        <div className={css.groupLabel}>新会话默认</div>
        <div className={css.card}>
          <label className={css.row}>
            <span className={css.fact}>
              <span>默认 Agent</span>
              <span>用于新建会话；进行中的会话保持它开始时的选择</span>
            </span>
            <select
              value={state.defaultProvider}
              disabled={!state.writable}
              onChange={(event) => {
                void setDefault(event.target.value)
              }}
            >
              {state.entries
                .filter(entry => entry.enabled)
                .map(entry => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
            </select>
          </label>
        </div>
      </div>
      <Modal
        open={confirm !== null}
        onClose={() => {
          setConfirm(null)
        }}
        title="确认渠道操作"
        closeLabel="取消操作"
      >
        <p>
          {confirm?.id}：
          {confirm?.kind === 'install'
            ? '下载官方渠道包并安装到 PaperAI 的独立目录；会运行该包的安装脚本。'
            : confirm?.kind === 'uninstall'
              ? '移除 PaperAI 托管安装。内置适配器、系统 CLI 和会话记录会保留。'
              : confirm?.kind === 'logout'
                ? '退出此主机上该渠道的登录状态。其他使用同一账户配置的应用也可能需要重新登录。'
                : '永久删除渠道中的这条外部历史；PaperAI 的本地记录不会一并删除。'}
        </p>
        <div className={css.actions}>
          <button
            type="button"
            onClick={() => {
              setConfirm(null)
            }}
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => {
              if (confirm === null) return
              if (confirm.kind === 'install' || confirm.kind === 'uninstall') void install(confirm.id, confirm.kind)
              else if (confirm.kind === 'logout') void manage(confirm.id, { kind: 'logout' })
              else if (confirm.sessionId !== undefined)
                void manage(confirm.id, { kind: 'delete', sessionId: confirm.sessionId })
              setConfirm(null)
            }}
          >
            确认
          </button>
        </div>
      </Modal>
      <Modal
        open={routing !== null}
        onClose={() => {
          setRouting(null)
        }}
        title="设置模型服务商"
        closeLabel="取消设置"
      >
        {routing !== null && (
          <form
            className={css.form}
            onSubmit={(event) => {
              event.preventDefault()
              try {
                const headers: unknown = JSON.parse(routing.headers)
                if (
                  headers === null ||
                  typeof headers !== 'object' ||
                  Array.isArray(headers) ||
                  Object.values(headers).some(value => typeof value !== 'string')
                )
                  throw new Error('请求头须为 JSON 字符串对象')
                void manage(routing.id, {
                  kind: 'set-provider',
                  providerId: routing.providerId,
                  apiType: routing.apiType,
                  baseUrl: routing.baseUrl,
                  headers: headers as Record<string, string>,
                })
                setRouting(null)
              } catch (error: unknown) {
                setRouting({ ...routing, error: String(error) })
              }
            }}
          >
            <p>{routing.providerId} · 本操作完整替换此渠道的服务商配置，包括请求头。</p>
            <label>
              API 协议
              <select
                value={routing.apiType}
                onChange={(event) => {
                  setRouting({ ...routing, apiType: event.target.value })
                }}
              >
                {state.management[routing.id]?.providers
                  ?.find(provider => provider.id === routing.providerId)
                  ?.supported.map(api => (
                    <option key={api}>{api}</option>
                  ))}
              </select>
            </label>
            <label>
              API 地址
              <input
                required
                type="url"
                value={routing.baseUrl}
                onChange={(event) => {
                  setRouting({ ...routing, baseUrl: event.target.value })
                }}
              />
            </label>
            <label>
              请求头 · JSON 对象
              <textarea
                value={routing.headers}
                onChange={(event) => {
                  setRouting({ ...routing, headers: event.target.value })
                }}
                autoComplete="off"
              />
            </label>
            {routing.error !== null && <p role="alert">{routing.error}</p>}
            <button type="submit">保存到渠道</button>
          </form>
        )}
      </Modal>
      <Modal
        open={draft !== null}
        onClose={cancelEdit}
        title="配置 ACP 渠道"
        description="启动配置用于之后建立的连接。空白凭据输入会保留已有值。"
        closeLabel="取消编辑"
        className={css.modal ?? ''}
      >
        {draft !== null && (
          <form
            className={css.form}
            onSubmit={(event) => {
              event.preventDefault()
              void save()
            }}
          >
            <fieldset disabled={state.saving}>
              <div className={css.fields}>
                <label>
                  渠道 ID
                  <input value={draft.id} readOnly />
                </label>
                <label>
                  显示名称
                  <input
                    value={draft.name}
                    required
                    onChange={(event) => {
                      updateDraft({ name: event.target.value })
                    }}
                  />
                </label>
                <label className={css.check}>
                  <input
                    type="checkbox"
                    checked={draft.enabled}
                    onChange={(event) => {
                      updateDraft({ enabled: event.target.checked })
                    }}
                  />
                  启用渠道
                </label>
              </div>
              <label>
                可执行命令
                <input
                  value={draft.command}
                  onChange={(event) => {
                    updateDraft({ command: event.target.value })
                  }}
                  placeholder="留空使用渠道默认命令"
                />
              </label>
              <label>
                启动参数 · JSON 数组
                <textarea
                  rows={2}
                  value={draft.args}
                  onChange={(event) => {
                    updateDraft({ args: event.target.value })
                  }}
                  spellCheck={false}
                />
              </label>
              <details>
                <summary>SSH 远程连接</summary>
                <label>
                  SSH 配置 · JSON 对象
                  <textarea
                    rows={4}
                    value={draft.ssh}
                    onChange={(event) => {
                      updateDraft({ ssh: event.target.value })
                    }}
                    placeholder={'{"host":"research-server","cwd":"/home/me/project"}'}
                    spellCheck={false}
                  />
                </label>
                <p className={css.note}>
                  留空在本机运行。远程 POSIX 主机须已安装 Node.js、对应 ACP 适配器，并使用 OpenSSH 密钥登录；PaperAI
                  论文工具通过 SSH 转发，文件回调不会访问本机目录。可设置 user、port、identityFile 和 node。
                </p>
              </details>
              <div className={css.fields}>
                {(draft.template === 'codex' || draft.template === 'claude') && (
                  <>
                    <label>
                      API Key
                      <input
                        type="password"
                        autoComplete="off"
                        value={draft.apiKey}
                        disabled={draft.clearKey}
                        onChange={(event) => {
                          updateDraft({ apiKey: event.target.value })
                        }}
                        placeholder="保留已有凭据"
                      />
                    </label>
                    <label>
                      Base URL
                      <input
                        value={draft.baseURL}
                        onChange={(event) => {
                          updateDraft({ baseURL: event.target.value })
                        }}
                        placeholder="留空使用渠道默认值"
                      />
                    </label>
                  </>
                )}
                <label>
                  网络代理
                  <input
                    value={draft.proxy}
                    onChange={(event) => {
                      updateDraft({ proxy: event.target.value })
                    }}
                    placeholder="例如 http://127.0.0.1:7890"
                  />
                </label>
                <label>
                  默认模型
                  <input
                    value={draft.model}
                    onChange={(event) => {
                      updateDraft({ model: event.target.value })
                    }}
                    list="acp-known-models"
                    placeholder="留空使用 Agent 默认模型"
                  />
                </label>
                <datalist id="acp-known-models">
                  {state.entries
                    .find(entry => entry.id === draft.id)
                    ?.diagnostic.models.map(model => (
                      <option key={model.id} value={model.id}>
                        {model.name}
                      </option>
                    ))}
                </datalist>
              </div>
              <details>
                <summary>高级设置</summary>
                <label>
                  环境变量 · JSON 对象
                  <textarea
                    rows={3}
                    value={draft.env}
                    disabled={draft.clearEnv}
                    onChange={(event) => {
                      updateDraft({ env: event.target.value })
                    }}
                    placeholder="留空保留；输入新对象会替换此渠道的环境变量覆盖"
                    spellCheck={false}
                  />
                </label>
                <div className={css.fields}>
                  <label className={css.check}>
                    <input
                      type="checkbox"
                      checked={draft.clearKey}
                      onChange={(event) => {
                        updateDraft({ clearKey: event.target.checked })
                      }}
                    />
                    清除已保存的 API Key
                  </label>
                  <label className={css.check}>
                    <input
                      type="checkbox"
                      checked={draft.clearEnv}
                      onChange={(event) => {
                        updateDraft({ clearEnv: event.target.checked })
                      }}
                    />
                    清除环境变量覆盖
                  </label>
                </div>
                <label>
                  默认思考强度
                  <input
                    value={draft.reasoningEffort}
                    onChange={(event) => {
                      updateDraft({ reasoningEffort: event.target.value })
                    }}
                    placeholder="仅填写渠道实际支持的值"
                  />
                </label>
                <label>
                  默认会话选项 · JSON 对象
                  <textarea
                    rows={3}
                    value={draft.configOptions}
                    onChange={(event) => {
                      updateDraft({ configOptions: event.target.value })
                    }}
                    spellCheck={false}
                  />
                </label>
                <label>
                  原生权限模式映射 · JSON 对象
                  <textarea
                    rows={3}
                    value={draft.permissionModes}
                    onChange={(event) => {
                      updateDraft({ permissionModes: event.target.value })
                    }}
                    placeholder={'{"read-only":"…","workspace-write":"…","danger-full-access":"…"}'}
                    spellCheck={false}
                  />
                </label>
                <p className={css.note}>留空使用 Codex、Claude 的默认权限映射。连接时会校验渠道实际提供的模式。</p>
              </details>
              <details>
                <summary>对话偏好</summary>
                <label>
                  回复语言
                  <input
                    value={draft.language}
                    onChange={(event) => {
                      updateDraft({ language: event.target.value })
                    }}
                    placeholder="例如 简体中文"
                  />
                </label>
                <label>
                  个人指令
                  <textarea
                    rows={4}
                    value={draft.personalPrompt}
                    onChange={(event) => {
                      updateDraft({ personalPrompt: event.target.value })
                    }}
                    placeholder="此渠道新会话使用的写作或交互偏好"
                  />
                </label>
              </details>
            </fieldset>
            {!draft.enabled && state.defaultProvider === draft.id && (
              <p className={css.note}>请先更换默认 Agent，再停用此渠道。</p>
            )}
            {state.draftError !== null && (
              <p role="alert" className={css.error}>
                {state.draftError}
              </p>
            )}
            <footer className={css.actions}>
              <button type="button" disabled={state.saving} onClick={cancelEdit}>
                取消
              </button>
              <button type="submit" disabled={state.saving || !state.writable}>
                {state.saving ? '保存中…' : '保存配置'}
              </button>
            </footer>
          </form>
        )}
      </Modal>
    </section>
  )
}
