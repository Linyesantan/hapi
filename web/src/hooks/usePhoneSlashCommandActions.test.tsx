import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { Session } from '@/types/api'
import { getPhoneSlashCommands } from '@/lib/phoneSlashCommands'
import { I18nProvider } from '@/lib/i18n-context'
import { usePhoneSlashCommandActions } from './usePhoneSlashCommandActions'

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn(async () => {}) }))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))

function setup(text: string, agent = 'codex', thinking = false, scheduledAt?: number) {
    const renameSession = vi.fn(async () => {})
    const createPhoneGatewaySession = vi.fn()
    const forwarded = vi.fn()
    const onFork = vi.fn(async () => {})
    function Harness() {
        const actions = usePhoneSlashCommandActions({
            enabled: true,
            api: { renameSession, createPhoneGatewaySession } as unknown as ApiClient,
            session: { id: 's1', active: true, thinking, metadata: { flavor: agent, path: '/中文项目', capabilities: { conversationHistory: { forkCurrent: true } } } } as Session,
            commands: getPhoneSlashCommands(agent), terminalSupported: true,
            onFiles: vi.fn(), onTerminal: vi.fn(), onFork,
        })
        return <><button onClick={async () => {
            const result = await actions.handle(text, false, scheduledAt)
            if (!result.handled) forwarded(result.text ?? text)
        }}>执行</button>{actions.dialog}</>
    }
    render(<I18nProvider><QueryClientProvider client={new QueryClient()}><Harness /></QueryClientProvider></I18nProvider>)
    return { renameSession, createPhoneGatewaySession, forwarded, onFork }
}

describe('手机网关命令执行', () => {
    it('新建命令只打开可选择 CLI 的页面，不提交模型或误创建会话', async () => {
        const state = setup('/new')
        fireEvent.click(screen.getByText('执行'))
        await waitFor(() => expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ to: '/sessions/new', search: { directory: '/中文项目' } })))
        expect(state.createPhoneGatewaySession).not.toHaveBeenCalled()
        expect(state.forwarded).not.toHaveBeenCalled()
    })
    it('Pi 输入 Codex 独有命令会说明适用范围，绝不透传', async () => {
        const state = setup('/fast on', 'pi')
        fireEvent.click(screen.getByText('执行'))
        expect(await screen.findByRole('dialog')).toHaveTextContent('当前会话是 Pi')
        expect(state.forwarded).not.toHaveBeenCalled()
    })
    it('正在运行任务时不执行分支', async () => {
        const state = setup('/fork', 'codex', true)
        fireEvent.click(screen.getByText('执行'))
        expect(await screen.findByRole('dialog')).toHaveTextContent('等待任务结束')
        expect(state.onFork).not.toHaveBeenCalled()
        expect(state.forwarded).not.toHaveBeenCalled()
    })
    it('会话重命名直接调用网关接口并保留中文参数', async () => {
        const state = setup('/rename 中文 名称')
        fireEvent.click(screen.getByText('执行'))
        await waitFor(() => expect(state.renameSession).toHaveBeenCalledWith('s1', '中文 名称'))
        expect(state.forwarded).not.toHaveBeenCalled()
    })
    it('完整帮助可按 CLI 搜索独有命令', async () => {
        const state = setup('/help')
        fireEvent.click(screen.getByText('执行'))
        await screen.findByRole('dialog')
        fireEvent.change(screen.getByLabelText('搜索命令说明'), { target: { value: '/fast' } })
        expect(screen.getByRole('dialog')).toHaveTextContent('/fast')
        expect(screen.getByRole('dialog')).not.toHaveTextContent('/tree')
        expect(state.forwarded).not.toHaveBeenCalled()
    })
    it('带定时的网关命令不会被提前执行', async () => {
        const state = setup('/rename 不应修改', 'codex', false, Date.now() + 60_000)
        fireEvent.click(screen.getByText('执行'))
        expect(await screen.findByRole('dialog')).toHaveTextContent('取消定时发送')
        expect(state.renameSession).not.toHaveBeenCalled()
        expect(state.forwarded).not.toHaveBeenCalled()
    })
})
