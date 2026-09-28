import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ApiError, type ApiClient } from '@/api/client'
import { I18nProvider } from '@/lib/i18n-context'
import { PhoneGatewayNewSession } from './PhoneGatewayNewSession'

function setup() {
    const create = vi.fn()
    const success = vi.fn()
    render(<I18nProvider><PhoneGatewayNewSession api={{ createPhoneGatewaySession: create } as unknown as ApiClient}
        onCancel={vi.fn()} onSuccess={success} /></I18nProvider>)
    return { create, success }
}

describe('手机网关新建会话', () => {
    it('创建时禁用重复提交，并把选定程序和中文目录交给网关', async () => {
        const { create, success } = setup()
        let finish!: (value: { session_id: string }) => void
        create.mockImplementation(() => new Promise(resolve => { finish = resolve }))
        fireEvent.click(screen.getByRole('radio', { name: 'Codex' }))
        fireEvent.change(screen.getByLabelText('电脑上的工作目录'), { target: { value: '/tmp/中文 项目' } })
        const submit = screen.getByRole('button', { name: '创建并启动' })
        fireEvent.click(submit)
        fireEvent.submit(submit.closest('form')!)
        expect(create).toHaveBeenCalledTimes(1)
        expect(create).toHaveBeenCalledWith({ agent: 'codex', directory: '/tmp/中文 项目', requestId: expect.any(String) })
        expect(submit).toBeDisabled()
        await act(async () => finish({ session_id: 'session-codex' }))
        expect(success).toHaveBeenCalledWith('session-codex')
    })

    it('连接失败保留表单，重复新建使用原请求 ID，换程序才生成新请求', async () => {
        const { create } = setup()
        create.mockRejectedValue(new Error('连接中断'))
        fireEvent.click(screen.getByRole('button', { name: '创建并启动' }))
        await screen.findByRole('alert')
        const first = create.mock.calls[0][0]
        fireEvent.click(screen.getByRole('button', { name: '创建并启动' }))
        await waitFor(() => expect(create).toHaveBeenCalledTimes(2))
        expect(create.mock.calls[1][0]).toEqual(first)
        await screen.findByRole('alert')
        fireEvent.click(screen.getByRole('radio', { name: 'Pi' }))
        fireEvent.click(screen.getByRole('button', { name: '创建并启动' }))
        await waitFor(() => expect(create).toHaveBeenCalledTimes(3))
        expect(create.mock.calls[2][0].requestId).not.toBe(first.requestId)
        expect(create.mock.calls[2][0].agent).toBe('pi')
    })

    it('已结束的启动不再复用旧请求，可以立即创建替代会话', async () => {
        const { create, success } = setup()
        create.mockRejectedValueOnce(new ApiError('ended', 400, 'gateway_session_ended'))
        create.mockResolvedValueOnce({ session_id: 'replacement' })
        fireEvent.click(screen.getByRole('button', { name: '创建并启动' }))
        await screen.findByRole('alert')
        const first = create.mock.calls[0][0].requestId
        fireEvent.click(screen.getByRole('button', { name: '创建并启动' }))
        await waitFor(() => expect(success).toHaveBeenCalledWith('replacement'))
        expect(create.mock.calls[1][0].requestId).not.toBe(first)
    })
})
