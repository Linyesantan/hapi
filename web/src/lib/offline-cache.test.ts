import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { OfflineCache, offlineScope, type MessagePageOptions } from './offline-cache'
import { ApiClient } from '@/api/client'
import type { DecryptedMessage, MessagesResponse } from '@/types/api'
import { clearMessageWindow, fetchOlderMessages, getMessageWindowState, restoreCachedMessageWindow, setMessageViewMode, syncTailMessages } from './message-window-store'

const opened: OfflineCache[] = []
const token = (ns = 'default') => `header.${btoa(JSON.stringify({ uid: 1, ns }))}.signature`
const message = (seq: number, text = `输出 ${seq}`): DecryptedMessage => ({
    id: `m-${seq}`, seq, localId: `local-${seq}`, createdAt: seq, invokedAt: seq,
    content: { role: 'agent', content: { type: 'codex', data: { type: 'message', message: text } } }
} as DecryptedMessage)

function page(messages: DecryptedMessage[], opts: Partial<MessagesResponse['page']> = {}): MessagesResponse {
    const first = messages[0]
    const last = messages.at(-1)
    return { messages, page: {
        direction: 'latest', limit: 200, epoch: 1, reset: false, hasMore: false,
        nextBeforeAt: first?.createdAt ?? null, nextBeforeSeq: first?.seq ?? null,
        nextAfterAt: last?.createdAt ?? null, nextAfterSeq: last?.seq ?? null,
        snapshotHeadAt: last?.createdAt ?? null, snapshotHeadSeq: last?.seq ?? null, ...opts
    } }
}

function cache(scope: string = crypto.randomUUID()) {
    const result = new OfflineCache(scope)
    opened.push(result)
    return result
}

async function allCached(c: OfflineCache, sessionId = 'session'): Promise<DecryptedMessage[]> {
    const rows: DecryptedMessage[] = []
    let options: MessagePageOptions = {}
    while (true) {
        const response = await c.readPage(sessionId, options)
        if (!response) return rows
        rows.unshift(...response.messages)
        if (!response.page.hasMore) return rows
        options = { beforeAt: response.page.nextBeforeAt, beforeSeq: response.page.nextBeforeSeq }
    }
}

beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    vi.stubGlobal('IDBKeyRange', IDBKeyRange)
})
afterEach(async () => {
    await Promise.all(opened.splice(0).map((c) => c.close()))
    clearMessageWindow('session')
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

describe('durable offline transcript', () => {
    it('两种等待队列分别缓存，另一台机器的原终端队列不会串用', async () => {
        const baseUrl = `http://${crypto.randomUUID()}.test`
        const api = new ApiClient(token(), { baseUrl })
        opened.push(api.offlineCache!)
        const native = { success: true, state: { sessionId: 'native', checkedAt: 123, running: true, queue: { status: 'visible', messages: [{ id: 'q', text: '原终端待处理' }] } } }
        const queued = { checkedAt: 123, sessions: [{ sessionId: 'session', messages: [{ id: 'web-q', content: '网页待处理' }] }] }
        vi.stubGlobal('fetch', async (url: string) => new Response(JSON.stringify(url.includes('native-codex') ? native : queued)))
        expect(await api.getNativeCodexTerminal('native', 'pc')).toEqual(native)
        expect(await api.getPhoneQueuedMessages()).toEqual(queued)
        await vi.waitFor(async () => expect(await api.offlineCache!.getValue('phone-queued-messages')).toEqual(queued))
        const reopened = new ApiClient(token(), { baseUrl })
        opened.push(reopened.offlineCache!)
        vi.stubGlobal('fetch', async () => { throw new TypeError('offline') })
        expect(await reopened.getNativeCodexTerminal('native', 'pc')).toEqual(native)
        expect(await reopened.getPhoneQueuedMessages()).toEqual(queued)
        await expect(reopened.getNativeCodexTerminal('native', 'another-pc')).rejects.toThrow('offline')
    })
    it('分别缓存三个 CLI 历史列表和动态命令，离线重开不会混淆相同的原生 ID', async () => {
        const baseUrl = `http://${crypto.randomUUID()}.test`
        const api = new ApiClient(token(), { baseUrl })
        opened.push(api.offlineCache!)
        const history = { success: true, sessions: [{ id: 'native-1', title: 'Codex 中文历史' }], machineId: 'pc' }
        const piHistory = { success: true, sessions: [{ id: 'native-1', title: 'Pi 中文历史', messageCount: 1 }], machineId: 'pc' }
        const opencodeHistory = { success: true, sessions: [{ id: 'native-1', title: 'OpenCode 中文历史' }], machineId: 'pc' }
        const commands = { success: true, commands: [{ name: 'project-task', source: 'project', content: '项目命令' }] }
        vi.stubGlobal('fetch', async (url: string) => new Response(JSON.stringify(url.includes('/codex/sessions') ? history
            : url.includes('/pi/sessions') ? piHistory : url.includes('/opencode/sessions') ? opencodeHistory : commands)))
        expect(await api.getCodexSessions()).toEqual(history)
        expect(await api.getPiSessions()).toEqual(piHistory)
        expect(await api.getOpencodeSessions()).toEqual(opencodeHistory)
        expect(await api.getSlashCommands('session')).toEqual(commands)
        await vi.waitFor(async () => expect(await api.offlineCache!.getValue('slash-commands:session')).toEqual(commands))
        const reopened = new ApiClient(token(), { baseUrl })
        opened.push(reopened.offlineCache!)
        vi.stubGlobal('fetch', async () => { throw new TypeError('offline') })
        expect(await reopened.getCodexSessions()).toEqual(history)
        expect(await reopened.getPiSessions()).toEqual(piHistory)
        expect(await reopened.getOpencodeSessions()).toEqual(opencodeHistory)
        expect(await reopened.getSlashCommands('session')).toEqual(commands)
    })
    it('reads 1,400 synced rows in bounded pages after reopening the database', async () => {
        const first = cache()
        for (let start = 1; start <= 1_400; start += 200) {
            await first.recordPage('session', page(Array.from({ length: 200 }, (_, i) => message(start + i))))
        }
        await first.close()
        const reopened = cache(first.scope)
        const rows = await allCached(reopened)
        expect(rows).toHaveLength(1_400)
        expect(rows[0].id).toBe('m-1')
        expect(rows.at(-1)?.id).toBe('m-1400')
        // A new cache instance must be able to update rows written before reload.
        await reopened.recordPage('session', page([message(1_400, '更新内容')]))
        expect((await reopened.readPage('session'))?.messages.at(-1)?.content).toEqual(message(1_400, '更新内容').content)
    })

    it('does not overwrite SSE with a stale in-flight page or duplicate its row', async () => {
        const c = cache()
        await c.recordPage('session', page([message(1)]))
        const ticket = c.beginRead('session')
        await c.ingest('session', [message(2, '最新内容')])
        await c.recordPage('session', page([message(2, '旧内容')]), ticket)
        expect((await allCached(c)).map((m) => m.content)).toEqual([message(1).content, message(2, '最新内容').content])
    })

    it('invalidates rewound epochs and rejects delayed older snapshots', async () => {
        const c = cache()
        await c.recordPage('session', page([message(1), message(2)]))
        const ticket = c.beginRead('session')
        await c.invalidate('session')
        await c.recordPage('session', page([message(1)], { epoch: 2, reset: true }))
        await c.recordPage('session', page([message(2)]), ticket)
        await c.recordPage('session', page([message(2)], { epoch: 1 }))
        expect((await allCached(c)).map((m) => m.id)).toEqual(['m-1'])
    })

    it('isolates hubs, accounts and sessions and removes deleted metadata', async () => {
        const a = cache(offlineScope('http://hub-a', token())!)
        const b = cache(offlineScope('http://hub-b', token())!)
        const other = cache(offlineScope('http://hub-a', token('other'))!)
        await a.recordPage('session', page([message(1)]))
        await a.recordPage('other-session', page([message(2)]))
        await a.putValue('sessions', { sessions: [{ id: 'session' }, { id: 'other-session' }] })
        await a.putValue('session:session', { session: { id: 'session' } })
        expect(await b.readPage('session')).toBeNull()
        expect(await other.readPage('session')).toBeNull()
        await a.invalidate('session', true)
        expect(await a.readPage('session')).toBeNull()
        expect(await a.getValue('session:session')).toBeNull()
        expect(await a.getValue('sessions')).toEqual({ sessions: [{ id: 'other-session' }] })
        expect((await a.readPage('other-session'))?.messages[0].id).toBe('m-2')
    })

    it('keeps large output intact and storage failures do not reject incoming live messages', async () => {
        const c = cache()
        const large = message(1, '彩色输出 '.repeat(100_000))
        await c.recordPage('session', page([large]))
        expect((await c.readPage('session'))?.messages[0]).toEqual(large)
        await c.close()
        vi.stubGlobal('indexedDB', { open: () => { throw new DOMException('quota', 'QuotaExceededError') } })
        await expect(c.ingest('session', [message(2)])).resolves.toBeUndefined()
        expect(c.getStatus()).toBe('storage-error')
    })

    it('restores and pages offline beyond the UI memory window', async () => {
        const c = cache()
        for (let start = 1; start <= 1_200; start += 200) {
            await c.recordPage('session', page(Array.from({ length: 200 }, (_, i) => message(start + i))))
        }
        const api = { offlineCache: c, getMessages: async (id: string, opts: MessagePageOptions) => c.readPage(id, opts) } as unknown as ApiClient
        await restoreCachedMessageWindow(api, 'session')
        expect(getMessageWindowState('session').messages).toHaveLength(200)
        setMessageViewMode('session', 'history')
        const seen = new Set<string>()
        while (true) {
            const state = getMessageWindowState('session')
            state.messages.forEach((m) => seen.add(m.id))
            expect(state.messages.length).toBeLessThanOrEqual(800)
            if (!state.hasMore) break
            expect((await fetchOlderMessages(api, 'session')).kind).toBe('applied')
        }
        expect(seen.size).toBe(1_200)
    })

    it('recovers a multi-page outage even when SSE already delivered the newest row', async () => {
        const baseUrl = `http://${crypto.randomUUID()}.test`
        const api = new ApiClient(token(), { baseUrl })
        const c = api.offlineCache!
        opened.push(c)
        await c.recordPage('session', page([message(1)]))
        await c.ingest('session', [message(702)])
        let online = false
        const requested: number[] = []
        const fetchMock = vi.fn(async (url: string) => {
            if (!online) throw new TypeError('network offline')
            const query = new URL(url).searchParams
            const after = Number(query.get('afterSeq') ?? 0)
            requested.push(after)
            const end = Math.min(702, after + 200)
            const messages = Array.from({ length: Math.max(0, end - after) }, (_, i) => message(after + i + 1))
            return new Response(JSON.stringify(page(messages, {
                direction: 'after', hasMore: end < 702,
                nextAfterAt: end, nextAfterSeq: end, snapshotHeadAt: 702, snapshotHeadSeq: 702
            })))
        })
        vi.stubGlobal('fetch', fetchMock)
        const offline = await api.getMessages('session', { limit: 200 })
        expect(offline.offline).toBe(true)
        online = true
        await api.getMessages('session', { afterAt: 702, afterSeq: 702, epoch: 1, limit: 200 })
        expect(requested.slice(0, 4)).toEqual([1, 201, 401, 601])
        expect((await allCached(c)).map((m) => m.seq)).toEqual(Array.from({ length: 702 }, (_, i) => i + 1))
        expect(c.getStatus()).toBe('online')
    })

    it('does not treat HTTP 401/403 as an offline success', async () => {
        const api = new ApiClient(token(), { baseUrl: `http://${crypto.randomUUID()}.test` })
        opened.push(api.offlineCache!)
        await api.offlineCache!.recordPage('session', page([message(1)]))
        vi.stubGlobal('fetch', async () => new Response('{}', { status: 401 }))
        await expect(api.getMessages('session', {})).rejects.toMatchObject({ status: 401 })
        vi.stubGlobal('fetch', async () => new Response('{}', { status: 403 }))
        await expect(api.getMessages('session', {})).rejects.toMatchObject({ status: 403 })
        expect(await api.offlineCache!.readPage('session')).toBeNull()
    })
})
