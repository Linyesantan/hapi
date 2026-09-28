import type { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { AGENT_MESSAGE_PAYLOAD_TYPE } from '@hapi/protocol'
import type { OpencodeLocalSessionSummary, OpencodeLocalSessionWithMessages } from '@hapi/protocol/apiTypes'
import { nativeAttachmentHistory } from './nativeAttachmentHistory'

type SessionRow = { id: string; title: string; directory: string; time_updated: number; revert: string | null }
type DataRow = { id: string; time_created: number; data: string }
type PartRow = DataRow & { message_id: string }
type ImportedMessage = OpencodeLocalSessionWithMessages['messages'][number]

function record(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function parse(value: string | null): Record<string, unknown> {
    try { return record(JSON.parse(value ?? '{}')) } catch { return {} }
}

export function getOpencodeDatabasePath(): string {
    return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'opencode', 'opencode.db')
}

async function readDatabase<T>(fallback: T, read: (db: Database, path: string) => T): Promise<T> {
    const path = getOpencodeDatabasePath()
    if (!existsSync(path)) return fallback
    const { Database } = await import('bun:sqlite')
    const db = new Database(path, { readonly: true })
    try {
        // A consistent read snapshot; never launch OpenCode or run its plugins.
        return db.transaction(() => read(db, path))()
    } finally {
        db.close()
    }
}

function summary(db: Database, path: string, row: SessionRow): OpencodeLocalSessionSummary {
    const last = db.query<DataRow, [string]>(`
        SELECT p.id, p.time_created, p.data FROM message m JOIN part p ON p.message_id = m.id
        WHERE m.session_id = ? AND json_extract(m.data, '$.role') = 'user'
          AND json_extract(p.data, '$.type') = 'text'
          AND COALESCE(json_extract(p.data, '$.synthetic'), 0) = 0
        ORDER BY m.time_created DESC, p.time_created DESC, p.id DESC LIMIT 1
    `).get(row.id)
    const text = last ? parse(last.data).text : undefined
    return {
        id: row.id,
        title: row.title || row.id,
        lastUserMessage: typeof text === 'string' ? text.slice(0, 300) : null,
        cwd: row.directory,
        file: path,
        modifiedAt: row.time_updated
    }
}

export async function listLocalOpencodeSessionSummaries(limit = 200): Promise<OpencodeLocalSessionSummary[]> {
    if (limit <= 0) return []
    return readDatabase([], (db, path) => db.query<SessionRow, [number]>(`
        SELECT id, title, directory, time_updated, revert FROM session
        WHERE parent_id IS NULL ORDER BY time_updated DESC, id DESC LIMIT ?
    `).all(limit).map(row => summary(db, path, row)))
}

function readMessages(db: Database, session: SessionRow): ImportedMessage[] {
    const attachmentHistory = nativeAttachmentHistory({ agent: 'opencode', sessionId: session.id })
    const rows = db.query<DataRow, [string]>(`
        SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created, id
    `).all(session.id)
    const parts = db.query<PartRow, [string]>(`
        SELECT id, message_id, time_created, data FROM part WHERE session_id = ? ORDER BY time_created, id
    `).all(session.id)
    const byMessage = new Map<string, PartRow[]>()
    for (const part of parts) {
        const list = byMessage.get(part.message_id) ?? []
        list.push(part)
        byMessage.set(part.message_id, list)
    }
    const revert = parse(session.revert)
    const messages: ImportedMessage[] = []
    for (const row of rows) {
        const isReverted = row.id === revert.messageID
        if (isReverted && !revert.partID) break
        const info = parse(row.data)
        const rowParts = byMessage.get(row.id) ?? []
        const visibleParts = isReverted
            ? rowParts.slice(0, Math.max(0, rowParts.findIndex(part => part.id === revert.partID)))
            : rowParts
        if (info.role === 'user') {
            const text = visibleParts.flatMap(part => {
                const data = parse(part.data)
                if (data.synthetic === true || data.ignored === true) return []
                if (data.type === 'text' && typeof data.text === 'string') return [data.text]
                if (data.type === 'file') return [`[附件: ${String(data.filename ?? data.mime ?? 'file')}]`]
                return []
            }).join('\n').trim()
            if (text) messages.push({
                localId: `opencode:${session.id}:${row.id}:user`, createdAt: row.time_created,
                content: { role: 'user', content: { type: 'text', text, attachments: attachmentHistory(text, visibleParts.flatMap(part => {
                    const data = parse(part.data)
                    return data.type === 'file' && typeof data.filename === 'string' ? [data.filename] : []
                })) }, meta: { sentFrom: 'cli' } }
            })
        } else if (info.role === 'assistant') {
            for (const part of visibleParts) {
                const data = parse(part.data)
                const push = (suffix: string, body: Record<string, unknown>) => {
                    const localId = `opencode:${session.id}:${part.id}:${suffix}`
                    messages.push({
                        localId, createdAt: part.time_created,
                        content: { role: 'agent', content: { type: AGENT_MESSAGE_PAYLOAD_TYPE, data: { ...body, id: localId } }, meta: { sentFrom: 'cli' } }
                    })
                }
                if ((data.type === 'text' || data.type === 'reasoning') && typeof data.text === 'string' && data.text.trim()) {
                    push(String(data.type), { type: data.type === 'reasoning' ? 'reasoning' : 'message', message: data.text })
                } else if (data.type === 'tool') {
                    const state = record(data.state)
                    const callId = typeof data.callID === 'string' ? data.callID : part.id
                    push('call', { type: 'tool-call', callId, name: data.tool ?? 'tool', input: state.input ?? {}, status: state.status === 'pending' || state.status === 'running' ? 'running' : 'completed' })
                    if (state.status === 'completed' || state.status === 'error') {
                        push('result', { type: 'tool-call-result', callId, output: state.output ?? state.error ?? '', is_error: state.status === 'error' })
                    }
                }
            }
        }
        if (isReverted) break
    }
    return messages
}

export async function listLocalOpencodeSessionsWithMessagesByIds(ids: Set<string>): Promise<OpencodeLocalSessionWithMessages[]> {
    if (ids.size === 0) return []
    return readDatabase([], (db, path) => {
        const query = db.query<SessionRow, [string]>('SELECT id, title, directory, time_updated, revert FROM session WHERE id = ?')
        return [...ids].flatMap(id => {
            const row = query.get(id)
            return row ? [{ ...summary(db, path, row), messages: readMessages(db, row) }] : []
        })
    })
}
