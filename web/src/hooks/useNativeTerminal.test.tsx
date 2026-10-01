import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { ApiClient } from '@/api/client'
import { ApiError } from '@/api/client'
import type { NativeTerminalInput } from '@hapi/protocol/apiTypes'
import { useNativeTerminalSend } from './useNativeTerminal'

beforeEach(() => {
    localStorage.clear()
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-15T12:00:00+08:00'))
})
afterEach(() => vi.restoreAllMocks())
const binding = 'a'.repeat(64)
function setup(send: (id: string, input: NativeTerminalInput) => Promise<unknown>) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const api = { sendNativeTerminalInput: send } as ApiClient
    return renderHook(() => useNativeTerminalSend(api, 'mirror'), {
        wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
    })
}

describe('手机向原终端发送', () => {
    it('响应丢失后保留草稿和编号，重新打开仍用同一编号核对', async () => {
        const send = vi.fn().mockRejectedValueOnce(new TypeError('网络中断')).mockImplementation(async (_id, input: NativeTerminalInput) => ({ success: true, receipt: { ...input, createdAt: Date.now(), status: 'submitted' } }))
        let hook = setup(send)
        await act(() => hook.result.current.send('同一条中文消息', binding))
        expect(hook.result.current.error?.text).toBe('同一条中文消息')
        const first = send.mock.calls[0][1]
        hook.unmount()
        hook = setup(send)
        await act(() => hook.result.current.send('同一条中文消息', binding))
        expect(send.mock.calls[1][1]).toEqual(first)
        expect(hook.result.current.error).toBeNull()
        expect(localStorage.getItem('hapi.native-input.v1.mirror')).toBeNull()
    })
    it('草稿冲突等明确拒绝允许下次使用新编号，不确定结果始终沿用原编号', async () => {
        const send = vi.fn().mockRejectedValueOnce(new ApiError('HTTP 409 Conflict', 409, undefined, JSON.stringify({ error: '原终端已有草稿' }))).mockImplementation(async (_id, input: NativeTerminalInput) => ({ success: true, receipt: { ...input, createdAt: Date.now(), status: 'indeterminate' } }))
        const hook = setup(send)
        await act(() => hook.result.current.send('中文输入', binding))
        expect(hook.result.current.error?.message).toBe('原终端已有草稿')
        await act(() => hook.result.current.send('中文输入', binding))
        expect(send.mock.calls[1][1].requestId).not.toBe(send.mock.calls[0][1].requestId)
        await act(() => hook.result.current.send('中文输入', binding))
        expect(send.mock.calls[2][1].requestId).toBe(send.mock.calls[1][1].requestId)
        expect(hook.result.current.error?.text).toBe('中文输入')
    })
    it('本地离线不会提交，保留用户文字', async () => {
        const send = vi.fn()
        const hook = setup(send)
        vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
        await act(() => hook.result.current.send('离线草稿', binding))
        expect(hook.result.current.error?.text).toBe('离线草稿')
        expect(send).not.toHaveBeenCalled()
    })
    it('服务器明确拒绝发送后可以用新的会话绑定重试', async () => {
        const send = vi.fn().mockResolvedValueOnce({ success: false, error: '原终端或会话已变化' })
            .mockImplementation(async (_id, input: NativeTerminalInput) => ({ success: true, receipt: { ...input, createdAt: Date.now(), status: 'submitted' } }))
        const hook = setup(send)
        await act(() => hook.result.current.send('保留中文草稿', binding))
        expect(hook.result.current.error?.text).toBe('保留中文草稿')
        await act(() => hook.result.current.send('保留中文草稿', 'b'.repeat(64)))
        expect(send.mock.calls[1][1].requestId).not.toBe(send.mock.calls[0][1].requestId)
        expect(send.mock.calls[1][1].binding).toBe('b'.repeat(64))
        expect(hook.result.current.error).toBeNull()
    })
})
