import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { ApiClient } from '@/api/client'
import type { NativeTerminalControl } from '@hapi/protocol/apiTypes'
import { useNativeTerminalControl } from './useNativeTerminalControl'

const binding = 'a'.repeat(64)
const messageId = '00000000-0000-4000-8000-000000000001'
beforeEach(() => {
    localStorage.clear()
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-16T12:00:00+08:00'))
})
afterEach(() => vi.restoreAllMocks())

function setup(control: (id: string, input: NativeTerminalControl) => Promise<unknown>) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const api = { controlNativeTerminal: control } as ApiClient
    return renderHook(() => useNativeTerminalControl(api, 'mirror'), {
        wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
    })
}

describe('原终端队列操作重试', () => {
    it('明确拒绝后刷新绑定可以重新操作，不会永久重试失效请求', async () => {
        const control = vi.fn().mockResolvedValueOnce({ success: false, error: '原终端状态已变化，请刷新后操作。' })
            .mockResolvedValue({ success: true, status: 'submitted' })
        const hook = setup(control)
        await act(() => hook.result.current.perform('cancel', binding, messageId))
        expect(hook.result.current.error).toContain('状态已变化')
        expect(localStorage.getItem('hapi.native-control.v1.mirror')).toBeNull()
        await act(() => hook.result.current.perform('cancel', 'b'.repeat(64), messageId))
        expect(control.mock.calls[1][1].requestId).not.toBe(control.mock.calls[0][1].requestId)
        expect(control.mock.calls[1][1].binding).toBe('b'.repeat(64))
        expect(hook.result.current.error).toBeNull()
    })

    it('响应丢失后重开页面，立即发送仍核对同一请求而不会再打断一次', async () => {
        const control = vi.fn().mockRejectedValueOnce(new TypeError('网络中断'))
            .mockResolvedValue({ success: true, status: 'submitted' })
        let hook = setup(control)
        await act(() => hook.result.current.perform('send-now', binding, messageId))
        const original = control.mock.calls[0][1]
        hook.unmount()
        hook = setup(control)
        await act(() => hook.result.current.perform('send-now', binding, messageId))
        expect(control.mock.calls[1][1]).toEqual(original)
        expect(hook.result.current.error).toBeNull()
    })

    it('尚未确认的操作不能被另一个队列操作覆盖', async () => {
        const control = vi.fn().mockResolvedValue({ success: true, status: 'indeterminate' })
        const hook = setup(control)
        await act(() => hook.result.current.perform('interrupt', binding))
        await act(() => hook.result.current.perform('cancel', binding, messageId))
        expect(control).toHaveBeenCalledTimes(1)
        expect(hook.result.current.error).toContain('上次操作尚未确认')
        await act(() => hook.result.current.perform('interrupt', binding))
        expect(control.mock.calls[1][1]).toEqual(control.mock.calls[0][1])
    })
})
