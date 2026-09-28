import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { SessionSummary } from '@/types/api'
import { PhoneHistorySessions } from './PhoneHistorySessions'

const native = { id: 'native-1', title: '已有中文对话', cwd: '/work/项目', file: '/transcript', modifiedAt: 123 }
const linked = (readOnly: boolean): SessionSummary => ({
    id: 'hapi-1', active: !readOnly, metadata: { flavor: 'codex', agentSessionId: native.id, path: '/work/项目', machineId: 'machine', codexHistoryReadOnly: readOnly },
}) as SessionSummary

function setup(sessions: SessionSummary[] = []) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const getCodexSessions = vi.fn(async () => ({ success: true, sessions: [native], machineId: 'machine' }))
    const syncCodexSession = vi.fn(async () => ({ success: true, hapiSessionIds: ['hapi-1'] }))
    const getPiSessions = vi.fn(async () => ({ success: true, sessions: [{ ...native, title: 'Pi 中文历史', messageCount: 1 }], machineId: 'machine' }))
    const importPiSessions = vi.fn(async () => ({ success: true, results: [{ piSessionId: native.id, hapiSessionId: 'pi-mirror' }] }))
    const getOpencodeSessions = vi.fn(async () => ({ success: true, sessions: [{ ...native, title: 'OpenCode 中文历史' }], machineId: 'machine' }))
    const syncOpencodeSession = vi.fn(async () => ({ success: true, hapiSessionIds: ['opencode-mirror'] }))
    const onSelect = vi.fn()
    render(<QueryClientProvider client={queryClient}><PhoneHistorySessions
        api={{ getCodexSessions, syncCodexSession, getPiSessions, importPiSessions, getOpencodeSessions, syncOpencodeSession } as unknown as ApiClient} sessions={sessions} onSelect={onSelect} />
    </QueryClientProvider>)
    return { syncCodexSession, importPiSessions, syncOpencodeSession, onSelect }
}
beforeEach(() => localStorage.clear())
afterEach(() => vi.restoreAllMocks())

describe('电脑三种终端历史入口', () => {
    it.each(['OpenCode', 'Pi'] as const)('选择 %s 会读取对应历史，即使原生 ID 与 Codex 相同也不串会话', async label => {
        const { syncCodexSession, importPiSessions, syncOpencodeSession, onSelect } = setup([linked(true)])
        await screen.findByText('已有中文对话')
        const select = screen.getByRole('button', { name: label })
        fireEvent.click(select)
        expect(select).toHaveAttribute('aria-pressed', 'true')
        fireEvent.click(await screen.findByRole('button', { name: new RegExp(`${label} 中文历史`) }))
        const importHistory = label === 'Pi' ? importPiSessions : syncOpencodeSession
        await waitFor(() => expect(importHistory).toHaveBeenCalledExactlyOnceWith({ sessionIds: [native.id], machineId: 'machine', readOnly: true }))
        expect(syncCodexSession).not.toHaveBeenCalled()
        expect(onSelect).toHaveBeenCalledWith(label === 'Pi' ? 'pi-mirror' : 'opencode-mirror')
    })

    it('已结束的网关会话不能冒充当前原终端连接，历史会重新只读同步', async () => {
        const { syncCodexSession } = setup([{ ...linked(false), active: false }])
        fireEvent.click(await screen.findByRole('button', { name: /已有中文对话/ }))
        await waitFor(() => expect(syncCodexSession).toHaveBeenCalledWith({ sessionIds: [native.id], machineId: 'machine', readOnly: true }))
    })

    it('切换终端清空上一种历史的搜索，返回时按钮选择仍明确', async () => {
        setup()
        await screen.findByText('已有中文对话')
        fireEvent.change(screen.getByLabelText('搜索电脑 Codex 会话'), { target: { value: '不存在' } })
        fireEvent.click(screen.getByRole('button', { name: 'OpenCode' }))
        expect(await screen.findByLabelText('搜索电脑 OpenCode 会话')).toHaveValue('')
        await screen.findByText('OpenCode 中文历史')
        fireEvent.click(screen.getByRole('button', { name: 'Codex' }))
        expect(await screen.findByText('已有中文对话')).toBeInTheDocument()
        expect(localStorage.getItem('hapi-phone-history-agent')).toBe('codex')
    })
    it('可搜索并只读打开原生会话，重复点击不会重复导入', async () => {
        const { syncCodexSession, onSelect } = setup()
        let finish!: (result: { success: boolean; hapiSessionIds: string[] }) => void
        syncCodexSession.mockImplementation(() => new Promise(resolve => { finish = resolve }))
        await screen.findByText('已有中文对话')
        fireEvent.change(screen.getByLabelText('搜索电脑 Codex 会话'), { target: { value: '不存在' } })
        expect(screen.queryByText('已有中文对话')).toBeNull()
        fireEvent.change(screen.getByLabelText('搜索电脑 Codex 会话'), { target: { value: '项目' } })
        const button = screen.getByRole('button', { name: /已有中文对话/ })
        fireEvent.click(button)
        fireEvent.click(button)
        expect(syncCodexSession).toHaveBeenCalledExactlyOnceWith({ sessionIds: ['native-1'], machineId: 'machine', readOnly: true })
        await act(async () => finish({ success: true, hapiSessionIds: ['hapi-1'] }))
        expect(onSelect).toHaveBeenCalledWith('hapi-1')
    })

    it('已接入的会话直接打开，不同步或改变运行中的 CLI', async () => {
        const { syncCodexSession, onSelect } = setup([linked(false)])
        fireEvent.click(await screen.findByRole('button', { name: /已有中文对话/ }))
        expect(syncCodexSession).not.toHaveBeenCalled()
        expect(onSelect).toHaveBeenCalledWith('hapi-1')
    })

    it('断网可以打开已经保存的只读记录', async () => {
        const { syncCodexSession, onSelect } = setup([linked(true)])
        await screen.findByText('已有中文对话')
        vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
        fireEvent.click(screen.getByRole('button', { name: /已有中文对话/ }))
        expect(syncCodexSession).not.toHaveBeenCalled()
        expect(onSelect).toHaveBeenCalledWith('hapi-1')
    })

    it('读取失败不创建程序、不跳入未知会话', async () => {
        const { syncCodexSession, onSelect } = setup()
        syncCodexSession.mockRejectedValue(new Error('transcript 不可读'))
        fireEvent.click(await screen.findByRole('button', { name: /已有中文对话/ }))
        expect(await screen.findByRole('alert')).toHaveTextContent('transcript 不可读')
        await waitFor(() => expect(onSelect).not.toHaveBeenCalled())
    })
})
