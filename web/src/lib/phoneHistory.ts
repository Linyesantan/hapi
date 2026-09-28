import type { ApiClient } from '@/api/client'
import type { CodexLocalSessionSummary, Session } from '@/types/api'
import type { PhoneGatewayAgent } from '@hapi/protocol/apiTypes'
import type { HistorySourceState } from '@hapi/protocol/schemas'
import { useEffect, useState } from 'react'

export const HISTORY_AGENTS = ['opencode', 'codex', 'pi'] as const
export const HISTORY_LABELS = { opencode: 'OpenCode', codex: 'Codex', pi: 'Pi' } as const
export type HistoryAgent = PhoneGatewayAgent
export type HistorySessionSummary = CodexLocalSessionSummary

export function historyAgent(value: unknown): HistoryAgent | null {
    return value === 'codex' || value === 'opencode' || value === 'pi' ? value : null
}

export function historySourceId(metadata: Session['metadata']): string | undefined {
    switch (metadata?.flavor) {
        case 'codex': return metadata.codexSourceSessionId ?? metadata.codexSessionId
        case 'opencode': return metadata.opencodeSessionId
        case 'pi': return metadata.piSessionId
    }
    return undefined
}

export async function getHistorySessions(api: ApiClient, agent: HistoryAgent) {
    const result = agent === 'codex' ? await api.getCodexSessions()
        : agent === 'pi' ? await api.getPiSessions() : await api.getOpencodeSessions()
    if (!result.success) throw new Error(result.error)
    return result
}

export async function syncHistorySession(api: ApiClient, agent: HistoryAgent, id: string, machineId?: string | null): Promise<string> {
    const request = { sessionIds: [id], machineId, readOnly: true as const }
    if (agent === 'pi') {
        const result = await api.importPiSessions(request)
        const imported = result.results.find(item => item.piSessionId === id)
        if (!result.success || imported?.error || !imported?.hapiSessionId) throw new Error(imported?.error?.message ?? result.error ?? '读取 Pi 记录失败')
        return imported.hapiSessionId
    }
    const result = agent === 'codex' ? await api.syncCodexSession(request) : await api.syncOpencodeSession(request)
    const sessionId = result.hapiSessionIds?.[0]
    if (!result.success || !sessionId) throw new Error(result.error ?? `读取 ${HISTORY_LABELS[agent]} 记录失败`)
    return sessionId
}

export function getHistoryStatus(source: HistorySourceState | undefined, now = Date.now(), online = typeof navigator === 'undefined' || navigator.onLine) {
    const running = online && source?.state === 'running' && now - source.checkedAt >= 0 && now - source.checkedAt < 60_000
    return { running, text: !online ? '缓存记录 · 只读' : running ? '原终端运行中' : '原终端历史 · 只读' }
}

export function useHistoryStatus(source: HistorySourceState | undefined, enabled = true) {
    const [now, setNow] = useState(Date.now)
    useEffect(() => {
        if (!enabled) return
        const update = () => setNow(Date.now())
        update()
        const timer = window.setInterval(update, 15_000)
        window.addEventListener('online', update)
        window.addEventListener('offline', update)
        return () => {
            window.clearInterval(timer)
            window.removeEventListener('online', update)
            window.removeEventListener('offline', update)
        }
    }, [enabled, source?.checkedAt])
    return getHistoryStatus(source, now)
}
