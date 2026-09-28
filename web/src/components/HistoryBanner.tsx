import { useState } from 'react'
import { HISTORY_LABELS, useHistoryStatus, type HistoryAgent } from '@/lib/phoneHistory'
import type { HistorySourceState } from '@hapi/protocol/schemas'

export function HistoryBanner(props: { sessionId: string; agent: HistoryAgent; sourceState?: HistorySourceState; onRefresh: () => Promise<unknown> | void;
    nativeStatus?: { text: string; running: boolean }; inputReason?: string }) {
    const storageKey = `hapi.history-banner.dismissed.${props.sessionId}`
    const [dismissed, setDismissed] = useState(() => {
        try {
            return localStorage.getItem(storageKey) === '1'
        } catch {
            return false
        }
    })
    const status = useHistoryStatus(props.sourceState, !dismissed)
    const [pending, setPending] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const dismiss = () => {
        setDismissed(true)
        try {
            localStorage.setItem(storageKey, '1')
        } catch {
            // 浏览器禁用存储时，仍可关闭当前页面的提示。
        }
    }
    const refresh = async () => {
        setPending(true)
        setError(null)
        try {
            await props.onRefresh()
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : '刷新失败，当前仍显示已读取的记录')
        } finally {
            setPending(false)
        }
    }
    if (dismissed) return null

    const currentStatus = props.nativeStatus ?? status
    const statusText = props.nativeStatus?.text ?? `${status.text}${status.running ? ' · 只读' : ''}`
    return <div role="region" aria-label="会话状态提示" className="mx-auto w-full max-w-content shrink-0 bg-[var(--app-subtle-bg)] px-3 text-xs">
        <div className="flex h-11 items-center gap-1">
            <div className="flex min-w-0 flex-1 items-center gap-1.5" title={[HISTORY_LABELS[props.agent], statusText, props.inputReason].filter(Boolean).join(' · ')}>
                <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${currentStatus.running ? 'bg-emerald-500' : 'bg-[var(--app-hint)]'}`} />
                <span className="shrink-0">{HISTORY_LABELS[props.agent]}</span>
                <span className={`truncate ${currentStatus.running ? 'text-emerald-600 dark:text-emerald-400' : 'text-[var(--app-hint)]'}`}>{statusText}</span>
            </div>
            <button type="button" onClick={() => { void refresh() }} disabled={pending}
                aria-label="刷新记录" title="刷新记录"
                className="h-11 min-w-11 shrink-0 rounded px-1 text-[var(--app-link)] hover:bg-[var(--app-border)] focus-visible:outline-2 focus-visible:outline-[var(--app-link)] disabled:opacity-50">{pending ? '刷新中' : '刷新'}</button>
            <button type="button" onClick={dismiss} aria-label="关闭会话提示" title="关闭会话提示"
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded text-[var(--app-hint)] hover:bg-[var(--app-border)] hover:text-[var(--app-text)] focus-visible:outline-2 focus-visible:outline-[var(--app-link)]">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                    <path d="M6 6l12 12M18 6L6 18" />
                </svg>
            </button>
        </div>
        {error ? <p role="alert" className="pb-2 text-xs text-red-600">{error}</p> : null}
    </div>
}
