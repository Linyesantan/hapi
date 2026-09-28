import { Hono } from 'hono'
import { NativeCodexTerminalRequestSchema, NativeTerminalRequestSchema, NativeTerminalInputSchema, NativeModelActionSchema,
    NativeTerminalControlSchema, NativeTerminalUploadSchema, DeleteUploadRequestSchema, type PhoneQueuedMessagesResponse } from '@hapi/protocol/apiTypes'
import { isReadOnlyHistory } from '@hapi/protocol/history'
import { unwrapRoleWrappedRecordEnvelope } from '@hapi/protocol/messages'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { phoneGatewayEnabled } from './phoneGateway'

export function createPhoneActivityRoutes(
    getSyncEngine: () => SyncEngine | null,
    enabled = phoneGatewayEnabled
): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/phone-gateway/native-terminal/:agent/:sessionId', async c => {
        if (!enabled()) return c.json({ error: '未启用手机网关' }, 404)
        const parsed = NativeTerminalRequestSchema.safeParse({ agent: c.req.param('agent'), sessionId: c.req.param('sessionId') })
        if (!parsed.success) return c.json({ error: '无效的原终端会话' }, 400)
        const engine = getSyncEngine()
        const machines = engine?.getOnlineMachinesByNamespace(c.get('namespace')) ?? []
        const requested = c.req.query('machineId')
        const machine = requested ? machines.find(item => item.id === requested) : machines[0]
        if (!engine || !machine) return c.json({ error: '原终端所在电脑暂未连接' }, 503)
        try {
            const result = await engine.readNativeTerminal(machine.id, parsed.data)
            return result.success ? c.json(result) : c.json({ error: '暂时无法读取原终端' }, 503)
        } catch { return c.json({ error: '暂时无法读取原终端，请稍后重试' }, 503) }
    })

    app.post('/phone-gateway/sessions/:sessionId/input', async c => {
        if (!enabled()) return c.json({ error: '未启用手机网关' }, 404)
        const input = NativeTerminalInputSchema.safeParse(await c.req.json().catch(() => null))
        if (!input.success) return c.json({ error: '无效的终端输入' }, 400)
        const engine = getSyncEngine()
        const namespace = c.get('namespace')
        const session = engine?.getSessionsByNamespace(namespace).find(item => item.id === c.req.param('sessionId'))
        if (!engine || !session) return c.json({ error: '会话不存在' }, 404)
        const metadata = session.metadata
        if (!isReadOnlyHistory(metadata)) return c.json({ error: '请使用该会话原有的发送入口' }, 409)
        const native = NativeTerminalRequestSchema.safeParse({ agent: metadata?.flavor,
            sessionId: metadata?.flavor === 'codex' ? metadata.codexSourceSessionId ?? metadata.codexSessionId : metadata?.opencodeSessionId })
        if (!native.success || !metadata?.machineId) return c.json({ error: '该记录没有可连接的原终端' }, 409)
        const machine = engine.getOnlineMachinesByNamespace(namespace).find(item => item.id === metadata.machineId)
        if (!machine) return c.json({ error: '原终端所在电脑暂未连接；草稿已保留' }, 503)
        try {
            const result = await engine.sendNativeTerminalInput(machine.id, { ...native.data, ...input.data })
            return result.success ? c.json(result) : c.json({ error: result.error }, 409)
        } catch {
            return c.json({ error: '发送结果暂时无法确认，请保留同一条消息重试核对，不要另建重复消息。' }, 503)
        }
    })

    app.post('/phone-gateway/sessions/:sessionId/model', async c => {
        if (!enabled()) return c.json({ error: '未启用手机网关' }, 404)
        const action = NativeModelActionSchema.safeParse(await c.req.json().catch(() => null))
        if (!action.success) return c.json({ error: '无效的模型菜单操作' }, 400)
        const engine = getSyncEngine()
        const namespace = c.get('namespace')
        const session = engine?.getSessionsByNamespace(namespace).find(item => item.id === c.req.param('sessionId'))
        if (!engine || !session) return c.json({ error: '会话不存在' }, 404)
        const metadata = session.metadata
        if (!isReadOnlyHistory(metadata)) return c.json({ error: '请使用该会话的网页模型选择器' }, 409)
        const native = NativeTerminalRequestSchema.safeParse({ agent: metadata?.flavor,
            sessionId: metadata?.flavor === 'codex' ? metadata.codexSourceSessionId ?? metadata.codexSessionId : metadata?.opencodeSessionId })
        if (!native.success || !metadata?.machineId) return c.json({ error: '该记录没有可连接的原终端' }, 409)
        const machine = engine.getOnlineMachinesByNamespace(namespace).find(item => item.id === metadata.machineId)
        if (!machine) return c.json({ error: '原终端所在电脑暂未连接' }, 503)
        try {
            const result = await engine.controlNativeModelMenu(machine.id, { ...native.data, ...action.data })
            return result.success ? c.json(result) : c.json({ error: result.error }, 409)
        } catch { return c.json({ error: '模型操作结果暂未确认，重试时会核对同一操作编号。' }, 503) }
    })

    app.get('/phone-gateway/native-codex/:sessionId', async (c) => {
        if (!enabled()) return c.json({ error: '未启用手机网关' }, 404)
        const parsed = NativeCodexTerminalRequestSchema.safeParse({ sessionId: c.req.param('sessionId') })
        if (!parsed.success) return c.json({ error: '无效的 Codex 会话' }, 400)
        const engine = getSyncEngine()
        const machines = engine?.getOnlineMachinesByNamespace(c.get('namespace')) ?? []
        const requested = c.req.query('machineId')
        const machine = requested ? machines.find(item => item.id === requested) : machines[0]
        if (!engine || !machine) return c.json({ error: '原终端所在电脑暂未连接' }, 503)
        try {
            const response = await engine.readNativeCodexTerminal(machine.id, parsed.data.sessionId)
            return response.success ? c.json(response) : c.json({ error: '暂时无法读取原终端状态' }, 503)
        } catch {
            return c.json({ error: '暂时无法读取原终端状态，请稍后刷新' }, 503)
        }
    })

    for (const operation of ['control', 'upload', 'upload/delete'] as const) {
        app.post(`/phone-gateway/sessions/:sessionId/${operation}`, async c => {
            if (!enabled()) return c.json({ error: '未启用手机网关' }, 404)
            const engine = getSyncEngine()
            const namespace = c.get('namespace')
            const session = engine?.getSessionsByNamespace(namespace).find(item => item.id === c.req.param('sessionId'))
            if (!engine || !session) return c.json({ error: '会话不存在' }, 404)
            const metadata = session.metadata
            if (!isReadOnlyHistory(metadata)) return c.json({ error: '请使用该会话的原有入口' }, 409)
            const native = NativeTerminalRequestSchema.safeParse({ agent: metadata?.flavor,
                sessionId: metadata?.flavor === 'codex' ? metadata.codexSourceSessionId ?? metadata.codexSessionId : metadata?.opencodeSessionId })
            if (!native.success || !metadata?.machineId) return c.json({ error: '没有可连接的原终端' }, 409)
            const machine = engine.getOnlineMachinesByNamespace(namespace).find(item => item.id === metadata.machineId)
            if (!machine) return c.json({ error: '原终端所在电脑暂未连接' }, 503)
            const body = await c.req.json().catch(() => null)
            try {
                if (operation === 'control') {
                    const parsed = NativeTerminalControlSchema.safeParse(body)
                    if (!parsed.success) return c.json({ error: '无效的终端操作' }, 400)
                    const result = await engine.controlNativeTerminal(machine.id, { ...native.data, ...parsed.data })
                    return result.success ? c.json(result) : c.json({ error: result.error }, 409)
                }
                if (operation === 'upload') {
                    const parsed = NativeTerminalUploadSchema.safeParse(body)
                    if (!parsed.success) return c.json({ error: '文件无效或超过 50 MB' }, 400)
                    const result = await engine.uploadNativeTerminalFile(machine.id, { ...native.data, ...parsed.data })
                    return c.json(result)
                }
                const parsed = DeleteUploadRequestSchema.safeParse(body)
                if (!parsed.success) return c.json({ error: '无效的附件' }, 400)
                return c.json(await engine.deleteNativeTerminalUpload(machine.id, { ...native.data, ...parsed.data }))
            } catch { return c.json({ error: operation === 'control' ? '操作结果待确认，请用同一操作编号重试核对。' : '附件操作暂未完成，请重试。' }, 503) }
        })
    }

    app.get('/phone-gateway/queued-messages', (c) => {
        if (!enabled()) return c.json({ error: '未启用手机网关' }, 404)
        const engine = getSyncEngine()
        if (!engine) return c.json({ error: '网关暂未连接' }, 503)
        const sessions: PhoneQueuedMessagesResponse['sessions'] = []
        for (const session of engine.getSessionsByNamespace(c.get('namespace'))) {
            if (isReadOnlyHistory(session.metadata)) continue
            // The latest page includes every uninvoked user row, independently
            // of its position in history. No execution/resume is requested.
            const messages = engine.getMessagesPage(session.id, { limit: 1 }).messages.filter(message =>
                message.invokedAt === null && unwrapRoleWrappedRecordEnvelope(message.content)?.role === 'user'
            )
            if (messages.length) sessions.push({ sessionId: session.id, messages })
        }
        return c.json({ checkedAt: Date.now(), sessions } satisfies PhoneQueuedMessagesResponse)
    })

    return app
}
