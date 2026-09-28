import { Hono } from 'hono'
import { z } from 'zod'
import { isDeepStrictEqual } from 'node:util'
import type { OpencodeLocalSessionWithMessages } from '@hapi/protocol/apiTypes'
import { isReadOnlyHistory } from '@hapi/protocol/history'
import type { Metadata } from '@hapi/protocol/types'
import type { Store } from '../../store'
import { truncateOversizedMessageContent } from '../../store/contentCodec'
import type { Machine, SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'

const requestSchema = z.object({
    sessionIds: z.array(z.string().trim().min(1).max(200)).min(1).max(100),
    machineId: z.string().trim().min(1).nullable().optional(),
    cwd: z.string().nullable().optional(),
    readOnly: z.literal(true).optional()
})

export function syncOpencodeHistory(options: {
    store: Store
    engine: SyncEngine
    machine: Machine
    namespace: string
    transcript: OpencodeLocalSessionWithMessages
}): string {
    const { store, engine, machine, namespace, transcript } = options
    const metadata: Metadata = {
        path: transcript.cwd ?? '', host: machine.metadata?.host ?? machine.id,
        machineId: machine.id, flavor: 'opencode', opencodeSessionId: transcript.id,
        name: transcript.title, historyReadOnly: true,
        historySourceState: transcript.sourceState ?? { state: 'unknown', checkedAt: Date.now() },
        lifecycleState: 'archived',
        ...(transcript.lastUserMessage ? { summary: { text: transcript.lastUserMessage, updatedAt: transcript.modifiedAt } } : {})
    }
    const session = store.sessions.getOrCreateSession(`opencode-history:${machine.id}:${transcript.id}`, metadata, {}, namespace)
    const prior = session.metadata as Metadata | null
    if (!isReadOnlyHistory(prior) || session.active || prior?.opencodeSessionId !== transcript.id || prior.machineId !== machine.id) {
        throw new Error('OpenCode history cannot overwrite a controllable session')
    }
    const now = Date.now()
    let timestamp = 0
    const source = transcript.messages.map(message => {
        timestamp = Math.max(timestamp, Math.min(Number.isFinite(message.createdAt) ? message.createdAt : now, now))
        return { ...message, createdAt: timestamp, invokedAt: timestamp, content: truncateOversizedMessageContent(message.content) }
    })
    if (new Set(source.map(message => message.localId)).size !== source.length) throw new Error('Duplicate OpenCode history message IDs')
    const existing = store.messages.getAllMessages(session.id)
    let prefix = 0
    while (prefix < existing.length && prefix < source.length
        && existing[prefix].localId === source[prefix].localId
        && existing[prefix].createdAt === source[prefix].createdAt
        && isDeepStrictEqual(existing[prefix].content, source[prefix].content)) prefix += 1

    if (prefix < existing.length) {
        const localId = existing[prefix].localId
        if (!localId) throw new Error('OpenCode history mirror contains an unidentified message')
        // OpenCode edits streaming parts in place. Replace only the changed
        // suffix of this read-only mirror; the native DB and live HAPI stay untouched.
        store.messages.truncateMessagesFromLocalId(session.id, localId, source.slice(prefix))
    } else {
        for (const message of source.slice(prefix)) store.messages.addImportedMessage(session.id, message.content, message.localId, message.createdAt)
    }
    const updated = store.sessions.updateSessionMetadata(session.id, { ...prior, ...metadata }, session.metadataVersion, namespace, { touchUpdatedAt: false })
    if (updated.result !== 'success') throw new Error('Failed to update OpenCode history metadata')
    engine.recordSessionActivity(session.id, transcript.modifiedAt)
    engine.handleRealtimeEvent({ type: 'session-updated', sessionId: session.id })
    for (const message of store.messages.getAllMessages(session.id).slice(prefix)) {
        engine.handleRealtimeEvent({ type: 'message-received', sessionId: session.id, message })
    }
    return session.id
}

export function createOpencodeSessionRoutes(options: { store: Store; getSyncEngine: () => SyncEngine | null }): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()
    const machineFor = (engine: SyncEngine, namespace: string, id?: string | null) => {
        const machines = engine.getOnlineMachinesByNamespace(namespace)
        return id ? machines.find(machine => machine.id === id) : machines[0]
    }
    app.get('/opencode/sessions', async c => {
        const engine = options.getSyncEngine()
        const machine = engine && machineFor(engine, c.get('namespace'), c.req.query('machineId'))
        if (!engine || !machine) return c.json({ success: false, error: 'No online machine available for OpenCode history', sessions: [] }, 503)
        const result = await engine.listOpencodeSessionsForMachine(machine.id, c.req.query('cwd'))
        if (!result.success) return c.json({ ...result, sessions: [], machineId: machine.id }, 503)
        return c.json({ ...result, machineId: machine.id })
    })
    app.post('/opencode/sync-session', async c => {
        const parsed = requestSchema.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ success: false, error: 'Invalid OpenCode history request' }, 400)
        const engine = options.getSyncEngine()
        const namespace = c.get('namespace')
        const machine = engine && machineFor(engine, namespace, parsed.data.machineId)
        if (!engine || !machine) return c.json({ success: false, error: 'No online machine available for OpenCode history' }, 503)
        const ids = [...new Set(parsed.data.sessionIds)]
        const result = await engine.listOpencodeSessionsForMachine(machine.id, parsed.data.cwd, ids)
        if (!result.success) return c.json(result, 503)
        const byId = new Map(result.sessions
            .filter((session): session is OpencodeLocalSessionWithMessages => 'messages' in session)
            .map(session => [session.id, session]))
        if (ids.some(id => !byId.has(id))) return c.json({ success: false, error: 'OpenCode session transcript not found' }, 404)
        try {
            const hapiSessionIds = ids.map(id => syncOpencodeHistory({ ...options, engine, machine, namespace, transcript: byId.get(id)! }))
            return c.json({ success: true, hapiSessionIds, machineId: machine.id })
        } catch (error) {
            return c.json({ success: false, error: error instanceof Error ? error.message : 'Failed to read OpenCode history' }, 409)
        }
    })
    return app
}
