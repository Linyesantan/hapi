import { describe, expect, it, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useSlashCommands } from './useSlashCommands'
import { getBuiltinSlashCommands } from '@/lib/codexSlashCommands'
import { getPhoneSlashCommands } from '@/lib/phoneSlashCommands'

// 锁定「两个分支对 /agent 的处理不同」这一行为。
//   unified（手机网关）：降级成「原终端」提示，保留可发现性
//   普通 web：直接从菜单里去掉，因为它一定执行不了
// 之前对两个分支都跑 filterUnavailableSlashCommands，导致 unified 分支把
// 那条「去原终端执行」的提示也删了 —— 浏览器实测 87 项掉到 86 项才发现。
describe('useSlashCommands — /agent 的分支差异', () => {
    const codexBuiltin = getBuiltinSlashCommands('codex')

    function wrapper({ children }: { children: ReactNode }) {
        const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    }

    const api = { getSlashCommands: vi.fn(async () => ({ success: true, commands: codexBuiltin })) } as never
    const sessionId = 'session-1'

    beforeEach(() => vi.clearAllMocks())

    it('unified + 共享 codex：保留 /agent，但降级为「原终端」提示', async () => {
        const { result } = renderHook(
            () => useSlashCommands(api, sessionId, 'codex', { unified: true, sharedCodex: true }),
            { wrapper }
        )
        await waitFor(() => expect(result.current.commands.length).toBeGreaterThan(0))

        const agent = result.current.commands.find((c) => c.name === 'agent')
        expect(agent).toBeDefined()
        // 「原终端 · 」是 terminalCommands 的标记，说明这条降级成了提示。
        // 不能只断言含「原终端」：非共享版的描述句子里也有这三个字。
        expect(agent?.description).toContain('原终端 ·')
        // 与 phoneSlashCommands 的既有行为一致
        expect(result.current.commands).toEqual(getPhoneSlashCommands('codex', codexBuiltin, true))
    })

    it('unified + 非共享 codex：/agent 是可执行的 builtin', async () => {
        const { result } = renderHook(
            () => useSlashCommands(api, sessionId, 'codex', { unified: true, sharedCodex: false }),
            { wrapper }
        )
        await waitFor(() => expect(result.current.commands.length).toBeGreaterThan(0))

        const agent = result.current.commands.find((c) => c.name === 'agent')
        expect(agent?.description).not.toContain('原终端 ·')
        expect(agent?.description).toContain('协作开关')
    })

    it('普通 web + 共享 codex：/agent 完全不出现在菜单里', async () => {
        const { result } = renderHook(
            () => useSlashCommands(api, sessionId, 'codex', { unified: false, sharedCodex: true }),
            { wrapper }
        )
        await waitFor(() => expect(result.current.commands.length).toBeGreaterThan(0))

        expect(result.current.commands.find((c) => c.name === 'agent')).toBeUndefined()
        // 其他 codex builtin 不受影响
        expect(result.current.commands.map((c) => c.name)).toEqual(expect.arrayContaining(['plan', 'model', 'goal']))
    })

    it('普通 web + 非共享 codex：/agent 保留', async () => {
        const { result } = renderHook(
            () => useSlashCommands(api, sessionId, 'codex', { unified: false, sharedCodex: false }),
            { wrapper }
        )
        await waitFor(() => expect(result.current.commands.length).toBeGreaterThan(0))

        expect(result.current.commands.find((c) => c.name === 'agent')).toBeDefined()
    })
})
