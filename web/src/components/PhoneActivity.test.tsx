import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { NativeCodexTerminalResponse } from '@hapi/protocol/apiTypes'
import type { DecryptedMessage, SessionSummary } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'
import { PhoneActivity } from './PhoneActivity'
import { NativeTerminalPanel } from './NativeTerminalPanel'

const nativeId = '01a097e3-aac0-7350-9aad-2f19502ffdfa'
const pendingText = '网页等待的第一行\n第二行\n第三行\n第四行也必须完整可读\n第五行'
const summary = (active = false, readOnly = false) => ({
    id: readOnly ? 'mirror' : 'old-web-session', active, updatedAt: 1,
    metadata: { path: '/work', name: '网页会话', flavor: 'codex', machineId: 'pc', agentSessionId: nativeId, historyReadOnly: readOnly }
}) as SessionSummary

function setup(sessions: SessionSummary[] = [summary()], panelOnly = false) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const state = { sessionId: nativeId, checkedAt: Date.now(), running: true,
        queue: { status: 'visible' as const, messages: [{ id: 'native-q', text: '原终端排队输入' }] },
        terminal: { text: '原终端真实画面\n› 输入区', columns: 80, rows: 24 } }
    const getNativeTerminal = vi.fn<() => Promise<NativeCodexTerminalResponse>>(async () => ({ success: true, state }))
    const syncCodexSession = vi.fn(async () => ({ success: true, hapiSessionIds: ['mirror'] }))
    const api = {
        getCodexSessions: vi.fn(async () => ({ success: true, machineId: 'pc', sessions: [{ id: nativeId, title: '当前原生 Codex', cwd: '/work', file: '/transcript', modifiedAt: Date.now(), sourceState: { state: 'running', checkedAt: Date.now() } }] })),
        getOpencodeSessions: vi.fn(async () => ({ success: true, sessions: [] })),
        getPiSessions: vi.fn(async () => ({ success: true, sessions: [] })),
        getPhoneQueuedMessages: vi.fn(async () => ({ checkedAt: Date.now(), sessions: [{ sessionId: 'old-web-session', messages: [{
            id: 'web-q', seq: 1, localId: 'web-local', createdAt: 1, invokedAt: null,
            content: { role: 'user', content: { type: 'text', text: pendingText }, meta: { sentFrom: 'web' } }
        } as DecryptedMessage] }] })),
        syncCodexSession, getNativeTerminal
    } as unknown as ApiClient
    const onSelect = vi.fn()
    const view = render(<QueryClientProvider client={client}>{panelOnly ? <NativeTerminalPanel api={api} nativeSessionId={nativeId} machineId="pc" />
        : <PhoneActivity api={api} sessions={sessions} onSelect={onSelect} />}</QueryClientProvider>)
    return { ...view, api, client, state, getNativeTerminal, syncCodexSession, onSelect }
}
afterEach(() => vi.restoreAllMocks())

describe('手机运行区与两类等待消息', () => {
    it('当前原生 Codex 独立显示在运行区，点击只读同步，不误跳已结束的网关会话', async () => {
        const { syncCodexSession, onSelect } = setup()
        const running = await screen.findByRole('region', { name: '正在运行的原终端' })
        fireEvent.click(within(running).getByRole('button', { name: /当前原生 Codex/ }))
        await waitFor(() => expect(onSelect).toHaveBeenCalledWith('mirror'))
        expect(syncCodexSession).toHaveBeenCalledExactlyOnceWith({ sessionIds: [nativeId], machineId: 'pc', readOnly: true })
        expect(onSelect).not.toHaveBeenCalledWith('old-web-session')
    })
    it('首页终端默认紧凑，展开后显示原终端队列，网页长文本完整保留', async () => {
        setup()
        const running = await screen.findByRole('region', { name: '正在运行的原终端' })
        expect(screen.queryByRole('region', { name: '原终端等待消息' })).toBeNull()
        fireEvent.click(within(running).getByRole('button', { name: '展开' }))
        const terminal = await screen.findByRole('region', { name: '原终端等待消息' })
        expect(await within(terminal).findByText('原终端排队输入')).toBeInTheDocument()
        const web = screen.getByRole('region', { name: '网页等待消息' })
        await within(web).findByRole('list', { name: '网页排队内容' })
        expect(within(web).getByRole('listitem').textContent).toBe(pendingText)
        expect(within(web).getByRole('listitem').className).not.toMatch(/line-clamp/)
    })
    it('已经接入网关的同一活跃会话不重复出现在原生运行区', async () => {
        const { api } = setup([summary(true)])
        await waitFor(() => expect(api.getCodexSessions).toHaveBeenCalled())
        await screen.findByRole('list', { name: '网页排队内容' })
        expect(screen.queryByRole('region', { name: '正在运行的原终端' })).toBeNull()
        expect(api.getNativeTerminal).not.toHaveBeenCalled()
    })
    it('断线显示上次读取的队列，仍能打开本地缓存的会话', async () => {
        const { syncCodexSession, onSelect } = setup([summary(false, true)])
        fireEvent.click(await screen.findByRole('button', { name: '展开' }))
        await screen.findByText('原终端排队输入')
        vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
        act(() => window.dispatchEvent(new Event('offline')))
        expect(screen.getByText('上次读取 · 连接后核对')).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: /当前原生 Codex/ }))
        expect(onSelect).toHaveBeenCalledWith('mirror')
        expect(syncCodexSession).not.toHaveBeenCalled()
    })
    it('原终端预览默认三行，可展开完整画面，队列变空后刷新消失', async () => {
        const { state, getNativeTerminal, client } = setup([], true)
        await screen.findByText('原终端排队输入')
        const terminal = screen.getByLabelText('原终端画面')
        expect(terminal.className).toContain('max-h-16')
        fireEvent.click(screen.getByRole('button', { name: '展开原终端画面' }))
        expect(screen.getByRole('button', { name: '收起原终端画面' })).toHaveAttribute('aria-expanded', 'true')
        getNativeTerminal.mockResolvedValue({ success: true, state: { ...state, queue: { status: 'visible', messages: [] } } })
        await act(() => client.invalidateQueries({ queryKey: queryKeys.nativeTerminal('codex', nativeId, 'pc') }))
        await screen.findByText('当前没有可见排队消息。')
        expect(screen.queryByText('原终端排队输入')).toBeNull()
    })
    it('原终端队列不可读时显示原因，不显示空队列的误导提示', async () => {
        const { state, getNativeTerminal, client } = setup([], true)
        await screen.findByText('原终端排队输入')
        getNativeTerminal.mockResolvedValue({ success: true, state: { ...state, queue: { status: 'unavailable', messages: [], note: '原终端处于选择模式' } } })
        await act(() => client.invalidateQueries({ queryKey: queryKeys.nativeTerminal('codex', nativeId, 'pc') }))
        await screen.findByText('原终端处于选择模式')
        expect(screen.queryByText('当前没有可见排队消息。')).toBeNull()
    })
})
