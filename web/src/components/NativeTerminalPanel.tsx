import { useState } from 'react'
import type { ApiClient } from '@/api/client'
import { useNativeTerminal } from '@/hooks/useNativeTerminal'
import { useNativeTerminalControl } from '@/hooks/useNativeTerminalControl'
import { MessageAttachments } from '@/components/AssistantChat/messages/MessageAttachments'

export function NativeTerminalPanel(props: {
    api: ApiClient | null
    nativeSessionId: string
    machineId?: string | null
    agent?: 'codex' | 'opencode'
    compact?: boolean
    sessionId?: string
}) {
    const query = useNativeTerminal(props.api, { agent: props.agent ?? 'codex', sessionId: props.nativeSessionId }, props.machineId)
    const control = useNativeTerminalControl(props.api, props.sessionId)
    const [expanded, setExpanded] = useState(false)
    const state = query.data
    if (state && !state.running && !state.submissions?.length) return null
    const stale = query.stale
    return (
        <section aria-label="原终端等待消息" className="mx-auto w-full max-w-content rounded-lg bg-[var(--app-subtle-bg)] px-3 py-2 text-xs">
            <div className="flex items-center justify-between gap-2 text-[var(--app-hint)]">
                <span>等待发送{state ? `（${(state.submissions?.filter(item => item.status === 'queued').length ?? 0) + state.queue.messages.length}）` : ''}</span>
                <span className={stale ? undefined : state?.busy ? 'text-orange-500' : 'text-emerald-600 dark:text-emerald-400'}>
                    {stale ? '上次读取 · 连接后核对' : state?.busy ? 'AI 正在回复' : 'AI 停止 · 等待输入'}
                </span>
            </div>
            {props.sessionId ? <div className="mt-2 flex items-center gap-2">
                <button type="button" disabled={stale || control.isPending || !state?.busy} onClick={() => void control.perform('interrupt', state?.input?.binding)}
                    className="min-h-9 rounded border border-[var(--app-divider)] px-3 text-[var(--app-fg)] disabled:opacity-40" aria-label="Esc 停止回复">Esc · 停止回复</button>
                {state?.busy ? <span className="text-[var(--app-hint)]">正在回复</span> : null}
            </div> : null}
            {state?.queue.status === 'visible' ? state.queue.messages.length ? (
                <ol className="mt-2 space-y-2" aria-label="原终端排队内容">
                    {state.queue.messages.map(message => <li key={message.id} className="whitespace-pre-wrap break-words rounded bg-[var(--app-bg)] px-2 py-1.5 text-sm">{message.text}</li>)}
                </ol>
            ) : !state.submissions?.length ? <p className="mt-1 text-[var(--app-hint)]">{stale ? '上次读取时没有等待消息。' : '当前没有等待消息。'}</p> : null
                : <p className="mt-1 text-[var(--app-hint)]">{query.isLoading ? '正在读取原终端…' : state?.queue.note ?? '暂时无法核对原终端队列。'}</p>}
            {state?.queue.messages.length && state.queue.note ? <p className="mt-1 text-[var(--app-hint)]">{state.queue.note}</p> : null}
            {state?.submissions?.length ? <ol className="mt-2 space-y-2" aria-label="手机发送待确认">
                {state.submissions.map(item => <li key={item.requestId} className="rounded bg-[var(--app-bg)] px-2 py-1.5">
                    <p className="whitespace-pre-wrap break-words text-sm">{item.text}</p>
                    {item.attachments?.length ? <MessageAttachments attachments={item.attachments} /> : null}
                    <p className="mt-1 text-[var(--app-hint)]">{item.note}</p>
                    {props.sessionId && item.status === 'queued' ? <div className="mt-2 flex flex-wrap gap-2">
                        <button type="button" disabled={stale || control.isPending} onClick={() => void control.perform('send-now', state.input?.binding, item.requestId)}
                            className="min-h-9 rounded border border-[var(--app-divider)] px-3 text-[var(--app-link)] disabled:opacity-40" title="停止当前回复并优先发送这条消息">立即发送</button>
                        <button type="button" disabled={stale || control.isPending} onClick={() => void control.perform('cancel', state.input?.binding, item.requestId)}
                            className="min-h-9 rounded border border-[var(--app-divider)] px-3 text-red-500 disabled:opacity-40">删除</button>
                    </div> : null}
                </li>)}
            </ol> : null}
            {control.error ? <p role="alert" className="mt-2 text-red-500">{control.error}</p> : null}
            {!props.compact && state?.terminal ? <div className="mt-2">
                <button type="button" aria-expanded={expanded} className="text-[var(--app-link)]" onClick={() => setExpanded(value => !value)}>
                    {expanded ? '收起原终端画面' : '展开原终端画面'}
                </button>
                <pre data-hapi-nested-scroll="true" className={`mt-1 overflow-auto rounded bg-[var(--app-bg)] p-2 text-[10px] leading-4 ${expanded ? 'max-h-[65vh]' : 'max-h-16'}`} aria-label="原终端画面">{expanded ? state.terminal.text : state.terminal.text.split('\n').filter(line => line.trim()).slice(-3).join('\n')}</pre>
            </div> : null}
        </section>
    )
}
