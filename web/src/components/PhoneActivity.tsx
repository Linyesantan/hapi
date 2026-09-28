import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { isReadOnlyHistory } from '@hapi/protocol/history'
import type { ApiClient } from '@/api/client'
import type { SessionSummary } from '@/types/api'
import { getHistorySessions, getHistoryStatus, HISTORY_AGENTS, HISTORY_LABELS, syncHistorySession, type HistoryAgent, type HistorySessionSummary } from '@/lib/phoneHistory'
import { queryKeys } from '@/lib/query-keys'
import { getSessionTitle } from '@/lib/sessionTitle'
import { useOnlineStatus } from '@/hooks/useOnlineStatus'
import { getQueuedMessagePreview, sortQueuedMessages } from '@/components/AssistantChat/QueuedMessagesBar'
import { NativeTerminalPanel } from './NativeTerminalPanel'
import { useNativeTerminal } from '@/hooks/useNativeTerminal'

function NativeBusyBadge(props: { api: ApiClient | null; agent: 'codex' | 'opencode'; sourceId: string; machineId?: string | null }) {
    const query = useNativeTerminal(props.api, { agent: props.agent, sessionId: props.sourceId }, props.machineId)
    if (!query.data) return null
    return <span className={`ml-auto shrink-0 rounded px-1.5 py-0.5 text-[10px] ${query.data.busy
        ? 'bg-orange-100 text-orange-600 dark:bg-orange-950 dark:text-orange-300' : 'bg-[var(--app-subtle-bg)] text-[var(--app-hint)]'}`}
        aria-label="AI 工作状态">{query.data.busy ? 'AI 工作中' : 'AI 已停止'}</span>
}

export function PhoneActivity(props: {
    api: ApiClient | null
    sessions: SessionSummary[]
    onSelect: (id: string) => void
}) {
    const queryClient = useQueryClient()
    const online = useOnlineStatus()
    const [opening, setOpening] = useState<string | null>(null)
    const openingRef = useRef(false)
    const [error, setError] = useState<string | null>(null)
    const [expandedTerminal, setExpandedTerminal] = useState<string | null>(null)
    const histories = useQueries({ queries: HISTORY_AGENTS.map(agent => ({
        queryKey: queryKeys.phoneHistorySessions(agent),
        queryFn: () => getHistorySessions(props.api!, agent),
        enabled: Boolean(props.api),
        networkMode: 'always' as const,
        refetchInterval: 15_000,
        staleTime: 10_000,
        retry: false
    })) })
    const queued = useQuery({
        queryKey: queryKeys.phoneQueuedMessages,
        queryFn: () => props.api!.getPhoneQueuedMessages(),
        enabled: Boolean(props.api), networkMode: 'always',
        refetchInterval: 3_000, staleTime: 1_000, retry: false
    })
    const running = histories.flatMap((query, index) => (query.data?.sessions ?? [])
        .filter(source => source.sourceState?.state === 'running')
        .map(source => ({ agent: HISTORY_AGENTS[index], source, machineId: query.data?.machineId })))
        .filter(({ agent, source, machineId }) => !props.sessions.some(session =>
            session.active && !isReadOnlyHistory(session.metadata) && session.metadata?.flavor === agent
            && session.metadata.agentSessionId === source.id
            && (!machineId || !session.metadata.machineId || session.metadata.machineId === machineId)))

    const open = async (agent: HistoryAgent, source: HistorySessionSummary, machineId?: string) => {
        if (openingRef.current) return
        const linked = props.sessions.filter(session => isReadOnlyHistory(session.metadata)
            && session.metadata?.flavor === agent && session.metadata.agentSessionId === source.id
            && (!machineId || !session.metadata.machineId || session.metadata.machineId === machineId))
            .sort((a, b) => b.updatedAt - a.updatedAt)[0]
        if (!online && linked) { props.onSelect(linked.id); return }
        if (!props.api) return
        openingRef.current = true
        setOpening(source.id)
        setError(null)
        try {
            const id = await syncHistorySession(props.api, agent, source.id, machineId)
            void queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
            props.onSelect(id)
        } catch (reason) {
            if (linked && (reason instanceof TypeError || !navigator.onLine || (reason instanceof DOMException && reason.name === 'TimeoutError'))) props.onSelect(linked.id)
            else setError(reason instanceof Error ? reason.message : '暂时无法打开原终端记录')
        } finally { openingRef.current = false; setOpening(null) }
    }
    const pending = queued.data?.sessions ?? []
    const pendingCount = pending.reduce((total, session) => total + session.messages.length, 0)
    const cached = !online || Boolean(queued.error) || Boolean(queued.data && Date.now() - queued.data.checkedAt > 10_000)
    return <div className="space-y-3 px-2 py-2" data-testid="phone-activity">
        {running.length ? <section aria-label="正在运行的原终端">
            <h2 className="mb-2 text-sm font-medium">正在运行的原终端（{running.length}）</h2>
            {running.map(({ agent, source, machineId }) => {
                const status = getHistoryStatus(source.sourceState, Date.now(), online)
                return <div key={`${agent}:${machineId}:${source.id}`} className="mb-2 rounded-lg border border-[var(--app-border)] p-2">
                    <div className="flex items-start gap-2">
                    <button type="button" disabled={opening !== null} data-running-agent={agent} data-native-session-id={source.id}
                        onClick={() => { void open(agent, source, machineId) }}
                        className="flex min-w-0 flex-1 flex-col gap-1 text-left disabled:opacity-60">
                        <span className="flex w-full min-w-0 items-center gap-2"><span className="shrink-0 text-xs font-medium text-[var(--app-link)]">{HISTORY_LABELS[agent]}</span>
                        <span className="truncate text-sm">{source.title || source.id}</span>
                        {agent === 'codex' || agent === 'opencode' ? <NativeBusyBadge api={props.api} agent={agent} sourceId={source.id} machineId={machineId} /> : null}</span>
                        <span className={`text-xs ${status.running ? 'text-emerald-600 dark:text-emerald-400' : 'text-[var(--app-hint)]'}`}>
                            {opening === source.id ? '正在读取…' : status.text} · 打开会话
                        </span>
                    </button>
                    <button type="button" aria-expanded={expandedTerminal === source.id} className="shrink-0 px-1 py-1 text-xs text-[var(--app-link)]"
                        onClick={() => setExpandedTerminal(value => value === source.id ? null : source.id)}>{expandedTerminal === source.id ? '收起' : '展开'}</button>
                    </div>
                    {expandedTerminal === source.id ? <div className="mt-2">
                        <p className="mb-2 truncate text-xs text-[var(--app-hint)]">{source.cwd}</p>
                        {agent === 'codex' || agent === 'opencode' ? <NativeTerminalPanel api={props.api} agent={agent} nativeSessionId={source.id} machineId={machineId} /> : null}
                    </div> : null}
                </div>
            })}
            {error ? <p role="alert" className="text-xs text-red-600">{error}</p> : null}
        </section> : histories.some(query => query.isError) ? <p role="status" className="text-xs text-[var(--app-hint)]">原终端状态暂时无法更新，已缓存的历史仍可查看。</p> : null}

        <section aria-label="网页等待消息" className="rounded-lg bg-[var(--app-subtle-bg)] p-2">
            <h2 className="text-sm font-medium">网页等待消息{queued.data ? `（${pendingCount}）` : ''}</h2>
            {cached ? <p className="mt-1 text-xs text-[var(--app-hint)]">上次读取的队列，连接恢复后核对。</p> : null}
            {pending.length ? <div className="mt-2 max-h-56 space-y-3 overflow-y-auto">
                {pending.map(item => <div key={item.sessionId}>
                    <button type="button" className="text-xs text-[var(--app-link)]" onClick={() => props.onSelect(item.sessionId)}>
                        {props.sessions.find(session => session.id === item.sessionId) ? getSessionTitle(props.sessions.find(session => session.id === item.sessionId)!) : item.sessionId}
                    </button>
                    <ol className="mt-1 space-y-1" aria-label="网页排队内容">{sortQueuedMessages(item.messages).map(message => {
                        const preview = getQueuedMessagePreview(message)
                        return <li key={message.id} className="whitespace-pre-wrap break-words rounded bg-[var(--app-bg)] p-2 text-sm">
                            {preview.text}{preview.attachmentNames.length ? <span className="block text-xs text-[var(--app-hint)]">📎 {preview.attachmentNames.join('、')}</span> : null}
                            {message.deliveryState === 'indeterminate' ? <span className="block text-xs text-[var(--app-hint)]">提交结果待确认</span> : null}
                            {message.scheduledAt ? <span className="block text-xs text-[var(--app-hint)]">定时：{new Date(message.scheduledAt).toLocaleString('zh-CN')}</span> : null}
                        </li>
                    })}</ol>
                </div>)}
            </div> : <p className="mt-1 text-xs text-[var(--app-hint)]">{queued.isLoading ? '正在读取网页队列…' : queued.isError ? '暂时无法核对网页队列。' : cached ? '上次读取时没有等待处理的网页消息。' : '没有等待处理的网页消息。'}</p>}
        </section>
    </div>
}
