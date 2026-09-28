import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { Hono } from 'hono'
import type { OpencodeLocalSessionWithMessages } from '@hapi/protocol/apiTypes'
import { Store } from '../../store'
import { SyncEngine, type Machine } from '../../sync/syncEngine'
import { RpcRegistry } from '../../socket/rpcRegistry'
import type { WebAppEnv } from '../middleware/auth'
import { createOpencodeSessionRoutes, syncOpencodeHistory } from './opencodeSessions'

const machine = { id: 'pc', namespace: 'default', active: true, metadata: { host: 'computer' } } as Machine
const transcript: OpencodeLocalSessionWithMessages = {
    id: 'native-1', title: '中文历史', cwd: '/work', file: '/data/opencode.db', modifiedAt: 2_000,
    messages: [
        { localId: 'opencode:native-1:user', createdAt: 1_000, content: { role: 'user', content: { type: 'text', text: '中文问题' }, meta: { sentFrom: 'cli' } } },
        { localId: 'opencode:native-1:thought', createdAt: 2_000, content: { role: 'agent', content: { type: 'codex', data: { type: 'reasoning', message: '正在分析' } }, meta: { sentFrom: 'cli' } } }
    ]
}

describe('OpenCode read-only history', () => {
    let store: Store
    let engine: SyncEngine
    beforeEach(() => {
        store = new Store(':memory:')
        engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
    })
    afterEach(() => { engine.stop(); store.close() })
    const sync = (source = transcript, selectedMachine = machine) => syncOpencodeHistory({ store, engine, machine: selectedMachine, namespace: 'default', transcript: source })

    it('isolates the mirror from a running HAPI session, reuses it and refuses execution', async () => {
        const live = engine.getOrCreateSession('live', { path: '/work', host: 'computer', machineId: 'pc', flavor: 'opencode', opencodeSessionId: 'native-1' }, {}, 'default')
        engine.handleSessionAlive({ sid: live.id, time: Date.now() })
        const before = store.sessions.getSession(live.id)
        const id = sync()
        const messageIds = store.messages.getAllMessages(id).map(message => message.id)
        expect(id).not.toBe(live.id)
        expect(sync()).toBe(id)
        expect(store.messages.getAllMessages(id).map(message => message.id)).toEqual(messageIds)
        expect(store.sessions.getSession(live.id)).toEqual(before)
        expect(engine.getSession(id)?.metadata?.historyReadOnly).toBe(true)
        expect(await engine.resumeSession(id, 'default')).toMatchObject({ type: 'error', code: 'resume_unavailable' })
        expect(await engine.reopenSession(id, 'default')).toMatchObject({ type: 'error', code: 'resume_unavailable' })
        await expect(engine.sendMessage(id, { text: 'cannot send', localId: 'send' })).rejects.toThrow('只读')
    })

    it('refreshes changed streaming parts and native undo without duplicating the stable prefix', () => {
        const id = sync()
        const prefixId = store.messages.getAllMessages(id)[0].id
        const next = structuredClone(transcript)
        next.messages[1].content = { role: 'agent', content: { type: 'codex', data: { type: 'reasoning', message: '完整思考摘要' } }, meta: { sentFrom: 'cli' } }
        expect(sync(next)).toBe(id)
        const updated = store.messages.getAllMessages(id)
        expect(updated).toHaveLength(2)
        expect(updated[0].id).toBe(prefixId)
        expect(updated[1].content).toMatchObject({ content: { data: { message: '完整思考摘要' } } })
        expect(store.messages.getMessageEpoch(id)).toBeGreaterThan(0)
        const ids = updated.map(message => message.id)
        sync(next)
        expect(store.messages.getAllMessages(id).map(message => message.id)).toEqual(ids)
        sync({ ...next, messages: next.messages.slice(0, 1) })
        expect(store.messages.getAllMessages(id).map(message => message.id)).toEqual([prefixId])
    })

    it('keeps identical native IDs separate across machines', () => {
        expect(sync()).not.toBe(sync(transcript, { ...machine, id: 'other-pc' }))
    })

    it('routes listing and selected history through the chosen machine and rejects writable imports', async () => {
        spyOn(engine, 'getOnlineMachinesByNamespace').mockReturnValue([machine])
        const list = spyOn(engine, 'listOpencodeSessionsForMachine').mockResolvedValue({ success: true, sessions: [transcript] })
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => { c.set('namespace', 'default'); await next() })
        app.route('/api', createOpencodeSessionRoutes({ store, getSyncEngine: () => engine }))
        expect((await app.request('/api/opencode/sessions?machineId=pc')).status).toBe(200)
        const request = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionIds: ['native-1'], machineId: 'pc', readOnly: true }) }
        const response = await app.request('/api/opencode/sync-session', request)
        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({ success: true, hapiSessionIds: [sync()] })
        expect(list).toHaveBeenLastCalledWith('pc', undefined, ['native-1'])
        expect((await app.request('/api/opencode/sync-session', { ...request, body: JSON.stringify({ sessionIds: ['native-1'], readOnly: false }) })).status).toBe(400)
        expect((await app.request('/api/opencode/sessions?machineId=someone-else')).status).toBe(503)
    })
})
