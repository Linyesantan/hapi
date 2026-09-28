import { useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { isReadOnlyHistory } from '@hapi/protocol/history'
import type { ApiClient } from '@/api/client'
import type { SessionSummary } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'
import { getHistorySessions, syncHistorySession, getHistoryStatus, historyAgent, HISTORY_AGENTS, HISTORY_LABELS, type HistoryAgent, type HistorySessionSummary } from '@/lib/phoneHistory'

const HISTORY_AGENT_KEY = 'hapi-phone-history-agent'

function initialAgent(): HistoryAgent {
    try { return historyAgent(localStorage.getItem(HISTORY_AGENT_KEY)) ?? 'codex' } catch { return 'codex' }
}

export function PhoneHistorySessions(props: {
    api: ApiClient | null
    sessions: SessionSummary[]
    selectedSessionId?: string | null
    onSelect: (sessionId: string) => void
}) {
    const queryClient = useQueryClient()
    const [agent, setAgent] = useState<HistoryAgent>(initialAgent)
    const label = HISTORY_LABELS[agent]
    const [search, setSearch] = useState('')
    const [limit, setLimit] = useState(12)
    const [opening, setOpening] = useState<string | null>(null)
    const openingRef = useRef(false)
    const [error, setError] = useState<string | null>(null)
    const query = useQuery({
        queryKey: queryKeys.phoneHistorySessions(agent),
        queryFn: async () => {
            if (!props.api) throw new Error('网关未连接')
            return await getHistorySessions(props.api, agent)
        },
        enabled: Boolean(props.api),
        networkMode: 'always',
        staleTime: 30_000,
        refetchInterval: 30_000,
        refetchOnWindowFocus: true,
        retry: false,
    })
    const linkedSessions = useMemo(() => {
        const result = new Map<string, SessionSummary>()
        for (const session of props.sessions) {
            const metadata = session.metadata
            if (metadata?.flavor !== agent || !metadata.agentSessionId) continue
            if (query.data?.machineId && metadata.machineId && metadata.machineId !== query.data.machineId) continue
            const previous = result.get(metadata.agentSessionId)
            const priority = (item: SessionSummary) => item.active && !isReadOnlyHistory(item.metadata) ? 3 : isReadOnlyHistory(item.metadata) ? 2 : 1
            if (!previous || priority(session) > priority(previous)
                || (priority(session) === priority(previous) && session.updatedAt > previous.updatedAt)) {
                result.set(metadata.agentSessionId, session)
            }
        }
        return result
    }, [props.sessions, query.data?.machineId, agent])
    const sessions = useMemo(() => {
        const entries = new Map<string, HistorySessionSummary>(
            (query.data?.sessions ?? []).map(session => [session.id, session]),
        )
        // 索引暂时不可读时，仍能打开已经同步到浏览器的历史。
        for (const [id, session] of linkedSessions) {
            if (!entries.has(id) && isReadOnlyHistory(session.metadata) && session.metadata) {
                entries.set(id, {
                    id,
                    title: session.metadata.name ?? session.metadata.summary?.text ?? id,
                    cwd: session.metadata.path,
                    modifiedAt: session.updatedAt,
                    file: '',
                    sourceState: session.metadata.historySourceState,
                })
            }
        }
        const keyword = search.trim().toLowerCase()
        return [...entries.values()]
            .filter(session => !keyword || [session.title, session.lastUserMessage, session.cwd, session.id]
                .some(value => value?.toLowerCase().includes(keyword)))
            .sort((a, b) => b.modifiedAt - a.modifiedAt)
    }, [query.data?.sessions, linkedSessions, search])

    const open = async (source: HistorySessionSummary) => {
        if (openingRef.current) return
        const linked = linkedSessions.get(source.id)
        if (linked && ((linked.active && !isReadOnlyHistory(linked.metadata))
            || (isReadOnlyHistory(linked.metadata) && !navigator.onLine))) {
            props.onSelect(linked.id)
            return
        }
        if (!props.api) return
        openingRef.current = true
        setOpening(source.id)
        setError(null)
        try {
            const sessionId = await syncHistorySession(props.api, agent, source.id, query.data?.machineId ?? linked?.metadata?.machineId)
            void queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
            props.onSelect(sessionId)
        } catch (reason) {
            if (linked && isReadOnlyHistory(linked.metadata) && (reason instanceof TypeError || !navigator.onLine
                || (reason instanceof DOMException && reason.name === 'TimeoutError'))) {
                props.onSelect(linked.id)
            } else {
                setError(!navigator.onLine
                    ? '这条记录尚未缓存，请联网后先打开一次。'
                    : reason instanceof Error ? reason.message : `读取 ${label} 记录失败`)
            }
        } finally {
            openingRef.current = false
            setOpening(null)
        }
    }

    return (
        <section aria-label="电脑终端历史" className="mt-3 border-t border-[var(--app-border)] px-2 pt-3">
            <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-sm font-medium">电脑上的历史会话</span>
                <button type="button" disabled={query.isFetching} onClick={() => { void query.refetch() }}
                    className="rounded px-2 py-1 text-xs text-[var(--app-link)] disabled:opacity-50">刷新</button>
            </div>
            <div role="group" aria-label="选择历史终端" className="mb-3 grid grid-cols-3 gap-1 rounded-lg bg-[var(--app-subtle-bg)] p-1">
                {HISTORY_AGENTS.map(value => <button key={value} type="button" aria-pressed={agent === value}
                    disabled={opening !== null} onClick={() => {
                        setAgent(value); setSearch(''); setLimit(12); setError(null)
                        try { localStorage.setItem(HISTORY_AGENT_KEY, value) } catch { /* Best effort. */ }
                    }}
                    className="rounded-md px-2 py-2 text-sm aria-pressed:bg-[var(--app-bg)] aria-pressed:font-medium aria-pressed:text-[var(--app-link)] disabled:opacity-50">
                    {HISTORY_LABELS[value]}
                </button>)}
            </div>
            <div className="mb-2 text-xs text-[var(--app-hint)]">{label} · {sessions.length} 条记录</div>
            <p className="mb-2 text-xs text-[var(--app-hint)]">可查看原终端的历史；已接入网关的会话可直接进入。</p>
            <input aria-label={`搜索电脑 ${label} 会话`} placeholder="搜索标题、目录或内容" value={search}
                onChange={event => { setSearch(event.target.value); setLimit(12) }}
                className="mb-2 w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-sm" />
            {error || query.error ? <p role="alert" className="py-2 text-sm text-red-600">
                {error ?? (query.error instanceof Error ? query.error.message : '读取列表失败')}
            </p> : null}
            {query.isLoading ? <p role="status" className="py-2 text-sm text-[var(--app-hint)]">正在读取 {label} 会话…</p> : null}
            {!query.isLoading && sessions.length === 0 ? <p className="py-2 text-sm text-[var(--app-hint)]">没有匹配的 {label} 记录</p> : null}
            {sessions.slice(0, limit).map(session => {
                const linked = linkedSessions.get(session.id)
                const connected = linked?.active && !isReadOnlyHistory(linked.metadata)
                const sourceStatus = getHistoryStatus(session.sourceState)
                return <button key={session.id} type="button" disabled={opening !== null}
                    data-history-agent={agent} data-native-session-id={session.id} data-codex-session-id={agent === 'codex' ? session.id : undefined}
                    aria-current={linked?.id === props.selectedSessionId ? 'page' : undefined}
                    onClick={() => { void open(session) }}
                    className="mb-1 flex w-full flex-col gap-1 rounded-lg px-2 py-2.5 text-left hover:bg-[var(--app-subtle-bg)] aria-[current=page]:bg-[var(--app-subtle-bg)] disabled:opacity-60">
                    <span className="line-clamp-2 break-words text-sm">{session.title || session.lastUserMessage || session.id}</span>
                    <span className="truncate text-xs text-[var(--app-hint)]">{session.cwd || session.id}</span>
                    <span className={`text-xs ${connected || sourceStatus.running ? 'text-emerald-600 dark:text-emerald-400' : 'text-[var(--app-hint)]'}`}>
                        {opening === session.id ? '正在读取…' : connected ? '已连接网关 · 可对话' : sourceStatus.text}
                        {' · '}{new Date(session.modifiedAt).toLocaleString('zh-CN')}
                    </span>
                </button>
            })}
            {sessions.length > limit ? <button type="button" onClick={() => setLimit(value => value + 24)}
                className="w-full rounded-lg py-2 text-sm text-[var(--app-link)]">显示更多（剩余 {sessions.length - limit}）</button> : null}
        </section>
    )
}
