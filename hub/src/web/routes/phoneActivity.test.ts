import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { Store } from '../../store'
import { SyncEngine, type Machine } from '../../sync/syncEngine'
import { RpcRegistry } from '../../socket/rpcRegistry'
import { createAuthMiddleware, type WebAppEnv } from '../middleware/auth'
import { createPhoneActivityRoutes } from './phoneActivity'

const nativeId = '01a097e3-aac0-7350-9aad-2f19502ffdfa'
const secret = new TextEncoder().encode('phone-activity-test')

describe('手机运行状态与等待消息', () => {
    let store: Store, engine: SyncEngine
    beforeEach(() => {
        store = new Store(':memory:')
        engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
    })
    afterEach(() => { engine.stop(); store.close() })
    async function setup(namespace = 'default', enabled = true) {
        const app = new Hono<WebAppEnv>()
        app.use('/api/*', createAuthMiddleware(secret))
        app.route('/api', createPhoneActivityRoutes(() => engine, () => enabled))
        const token = await new SignJWT({ uid: 1, ns: namespace }).setProtectedHeader({ alg: 'HS256' }).sign(secret)
        return { app, get: (path: string) => app.request('/api/phone-gateway/' + path, { headers: { authorization: 'Bearer ' + token } }),
            post: (path: string, body: unknown) => app.request('/api/phone-gateway/' + path, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(body) }) }
    }
    it('当前 Codex 状态只从本命名空间的指定机器读取，且需要认证', async () => {
        const state = { sessionId: nativeId, checkedAt: Date.now(), running: true, queue: { status: 'visible' as const, messages: [{ id: 'q', text: '等待中文输入' }] } }
        const machines = spyOn(engine, 'getOnlineMachinesByNamespace').mockImplementation(namespace => namespace === 'default' ? [{ id: 'pc' } as Machine] : [])
        const read = spyOn(engine, 'readNativeCodexTerminal').mockResolvedValue({ success: true, state })
        const owner = await setup()
        expect((await owner.app.request('/api/phone-gateway/native-codex/' + nativeId)).status).toBe(401)
        expect((await owner.get('native-codex/bad-id')).status).toBe(400)
        expect((await owner.get(`native-codex/${nativeId}?machineId=other`)).status).toBe(503)
        expect(read).not.toHaveBeenCalled()
        expect(await (await owner.get(`native-codex/${nativeId}?machineId=pc`)).json()).toEqual({ success: true, state })
        expect(read).toHaveBeenCalledWith('pc', nativeId)
        expect((await (await setup('other')).get(`native-codex/${nativeId}`)).status).toBe(503)
        expect(machines).toHaveBeenCalledWith('other')
    })
    it('列出已停止会话的旧排队消息，排除已消费正文、只读镜像和其他用户', async () => {
        const session = engine.getOrCreateSession('own', { path: '/work', host: 'pc', flavor: 'codex' }, {}, 'default')
        const foreign = engine.getOrCreateSession('foreign', { path: '/work', host: 'pc' }, {}, 'other')
        const mirror = engine.getOrCreateSession('mirror', { path: '/work', host: 'pc', historyReadOnly: true }, {}, 'default')
        const user = (text: string) => ({ role: 'user', content: { type: 'text', text }, meta: { sentFrom: 'web' } })
        store.messages.addMessage(session.id, user('先等待的中文消息'), 'pending')
        store.messages.addMessage(session.id, user('已经执行'), 'done')
        store.messages.markMessagesInvoked(session.id, ['done'], Date.now())
        store.messages.addMessage(foreign.id, user('其他用户'), 'private')
        store.messages.addMessage(mirror.id, user('历史镜像'), 'history')
        // Later agent output must not push the queued row out of the latest-page response.
        store.messages.addMessage(session.id, { role: 'agent', content: { type: 'codex', data: { type: 'message', message: '更新输出' } } }, 'agent')
        const before = store.messages.getAllMessages(session.id)
        const response = await (await (await setup()).get('queued-messages')).json() as { sessions: Array<{ sessionId: string; messages: Array<{ localId: string }> }> }
        expect(response.sessions.map(item => item.sessionId)).toEqual([session.id])
        expect(response.sessions[0].messages.map(item => item.localId)).toEqual(['pending'])
        expect(store.messages.getAllMessages(session.id)).toEqual(before)
        expect(engine.getSession(session.id)?.active).toBe(false)
    })
    it('未启用的网关不暴露终端或队列接口，RPC 错误不暴露私有输出', async () => {
        const disabled = await setup('default', false)
        expect((await disabled.get('queued-messages')).status).toBe(404)
        expect((await disabled.get(`native-codex/${nativeId}`)).status).toBe(404)
        spyOn(engine, 'getOnlineMachinesByNamespace').mockReturnValue([{ id: 'pc' } as Machine])
        spyOn(engine, 'readNativeCodexTerminal').mockRejectedValue(new Error('PRIVATE_ENV'))
        const response = await (await setup()).get(`native-codex/${nativeId}`)
        expect(response.status).toBe(503)
        expect(await response.text()).not.toContain('PRIVATE_ENV')
    })
    it('输入只路由到镜像绑定的原生会话，不启动或恢复第二个执行器', async () => {
        const session = engine.getOrCreateSession('native', { path: '/work', host: 'pc', flavor: 'codex', machineId: 'pc', codexSessionId: nativeId, historyReadOnly: true }, {}, 'default')
        spyOn(engine, 'getOnlineMachinesByNamespace').mockImplementation(ns => ns === 'default' ? [{ id: 'pc' } as Machine] : [])
        const body = { requestId: crypto.randomUUID(), binding: 'a'.repeat(64), text: '手机继续同一条会话' }
        const send = spyOn(engine, 'sendNativeTerminalInput').mockResolvedValue({ success: true, receipt: { requestId: body.requestId, text: body.text, createdAt: 1, status: 'submitted' } })
        const owner = await setup()
        expect((await owner.post(`sessions/${session.id}/input`, { ...body, machineId: 'foreign', sessionId: 'foreign' })).status).toBe(200)
        expect(send).toHaveBeenCalledWith('pc', { ...body, agent: 'codex', sessionId: nativeId })
        expect(engine.getSession(session.id)?.active).toBe(false)
        expect(store.messages.getAllMessages(session.id)).toHaveLength(0)
        expect((await (await setup('other')).post(`sessions/${session.id}/input`, body)).status).toBe(404)
        expect((await owner.post(`sessions/${session.id}/input`, { ...body, text: '\x1b[A' })).status).toBe(400)
        expect(send).toHaveBeenCalledTimes(1)
    })
    it('OpenCode 使用同一套终端读取，非法会话和普通网关会话不能借用此输入通道', async () => {
        const owner = await setup()
        spyOn(engine, 'getOnlineMachinesByNamespace').mockReturnValue([{ id: 'pc' } as Machine])
        const state = { sessionId: 'ses_NewTerminal', checkedAt: Date.now(), running: true, queue: { status: 'visible' as const, messages: [] } }
        const read = spyOn(engine, 'readNativeTerminal').mockResolvedValue({ success: true, state })
        expect((await owner.get('native-terminal/opencode/ses_NewTerminal?machineId=pc')).status).toBe(200)
        expect(read).toHaveBeenCalledWith('pc', { agent: 'opencode', sessionId: 'ses_NewTerminal' })
        expect((await owner.get('native-terminal/opencode/invalid')).status).toBe(400)
        const regular = engine.getOrCreateSession('regular', { path: '/work', host: 'pc', flavor: 'codex' }, {}, 'default')
        expect((await owner.post(`sessions/${regular.id}/input`, { requestId: crypto.randomUUID(), binding: 'a'.repeat(64), text: '测试' })).status).toBe(409)
    })
    it('模型菜单操作只作用于认证用户的原会话，拒绝任意终端按键', async () => {
        const session = engine.getOrCreateSession('model-native', { path: '/work', host: 'pc', flavor: 'opencode', machineId: 'pc', opencodeSessionId: 'ses_ModelTest', historyReadOnly: true }, {}, 'default')
        spyOn(engine, 'getOnlineMachinesByNamespace').mockImplementation(ns => ns === 'default' ? [{ id: 'pc' } as Machine] : [])
        const body = { requestId: crypto.randomUUID(), binding: 'a'.repeat(64), action: 'open' }
        const control = spyOn(engine, 'controlNativeModelMenu').mockResolvedValue({ success: true, requestId: body.requestId, status: 'submitted',
            state: { sessionId: 'ses_ModelTest', checkedAt: 1, running: true, queue: { status: 'visible', messages: [] } } })
        const owner = await setup()
        expect((await owner.post(`sessions/${session.id}/model`, { ...body, agent: 'codex', sessionId: 'foreign', machineId: 'foreign' })).status).toBe(200)
        expect(control).toHaveBeenCalledWith('pc', { ...body, agent: 'opencode', sessionId: 'ses_ModelTest' })
        expect((await (await setup('other')).post(`sessions/${session.id}/model`, body)).status).toBe(404)
        expect((await owner.post(`sessions/${session.id}/model`, { ...body, action: 'C-c' })).status).toBe(400)
        expect((await owner.post(`sessions/${session.id}/model`, { ...body, action: 'confirm' })).status).toBe(400)
        expect(control).toHaveBeenCalledTimes(1)
        expect(store.messages.getAllMessages(session.id)).toHaveLength(0)
    })
    it('附件上传和队列控制沿镜像的机器绑定路由，不能冒认其他用户或发送任意按键', async () => {
        const session = engine.getOrCreateSession('attachment-native', { path: '/work', host: 'pc', flavor: 'opencode', machineId: 'pc', opencodeSessionId: 'ses_Attachments', historyReadOnly: true }, {}, 'default')
        spyOn(engine, 'getOnlineMachinesByNamespace').mockImplementation(ns => ns === 'default' ? [{ id: 'pc' } as Machine] : [])
        const upload = spyOn(engine, 'uploadNativeTerminalFile').mockResolvedValue({ success: true, path: '/uploads/photo.png' })
        const remove = spyOn(engine, 'deleteNativeTerminalUpload').mockResolvedValue({ success: true })
        const requestId = crypto.randomUUID()
        const control = spyOn(engine, 'controlNativeTerminal').mockResolvedValue({ success: true, requestId, status: 'submitted', state: { sessionId: 'ses_Attachments', checkedAt: 1, running: true, queue: { status: 'visible', messages: [] } } })
        const body = { filename: '中文.txt', mimeType: 'text/plain', content: Buffer.from('中文').toString('base64') }
        const owner = await setup()
        expect((await owner.post(`sessions/${session.id}/upload`, { ...body, machineId: 'foreign', sessionId: 'foreign' })).status).toBe(200)
        expect(upload).toHaveBeenCalledWith('pc', { ...body, agent: 'opencode', sessionId: 'ses_Attachments' })
        expect((await owner.post(`sessions/${session.id}/upload/delete`, { path: '/uploads/photo.png' })).status).toBe(200)
        expect(remove).toHaveBeenCalledWith('pc', { path: '/uploads/photo.png', agent: 'opencode', sessionId: 'ses_Attachments' })
        const action = { requestId, binding: 'b'.repeat(64), action: 'cancel', messageId: crypto.randomUUID() }
        expect((await owner.post(`sessions/${session.id}/control`, action)).status).toBe(200)
        expect(control).toHaveBeenCalledWith('pc', { ...action, agent: 'opencode', sessionId: 'ses_Attachments' })
        expect((await owner.post(`sessions/${session.id}/control`, { ...action, action: 'C-c' })).status).toBe(400)
        const other = await setup('other')
        expect((await other.post(`sessions/${session.id}/upload`, body)).status).toBe(404)
        expect((await other.post(`sessions/${session.id}/control`, action)).status).toBe(404)
        expect(upload).toHaveBeenCalledTimes(1)
        expect(control).toHaveBeenCalledTimes(1)
    })
})
