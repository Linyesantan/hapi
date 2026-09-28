import { describe, expect, it } from 'bun:test'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'

describe('history execution guards', () => {
    for (const metadata of [
        { flavor: 'codex', codexHistoryReadOnly: true },
        { flavor: 'opencode', historyReadOnly: true },
        { flavor: 'pi', historyReadOnly: true }
    ]) it(`blocks send, resume and reopen for ${metadata.flavor} including legacy mirrors`, async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
        try {
            const session = engine.getOrCreateSession('history', { path: '/work', host: 'pc', ...metadata }, {}, 'default')
            expect(await engine.resumeSession(session.id, 'default')).toMatchObject({ type: 'error', code: 'resume_unavailable' })
            expect(await engine.reopenSession(session.id, 'default')).toMatchObject({ type: 'error', code: 'resume_unavailable' })
            await expect(engine.sendMessage(session.id, { text: 'test', localId: 'test' })).rejects.toThrow('只读')
            expect(store.messages.getAllMessages(session.id)).toHaveLength(0)
        } finally { engine.stop(); store.close() }
    })
})
