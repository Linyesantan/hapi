import type { DecryptedMessage, MessagesResponse } from '@/types/api'

export type MessagePageOptions = {
    beforeSeq?: number | null
    beforeAt?: number | null
    afterSeq?: number | null
    afterAt?: number | null
    untilSeq?: number | null
    untilAt?: number | null
    epoch?: number | null
    limit?: number
}

export type CachedMessagesResponse = MessagesResponse & { offline?: boolean }
type Position = { at: number; seq: number }
type Checkpoint = { epoch: number; head: Position | null }
type Row = { scope: string; sessionId: string; id: string; at: number; seq: number; reverseAt: number; reverseSeq: number; revision: number; writer: string; message: DecryptedMessage }
type Meta = { scope: string; key: string; value: unknown }
type ReadTicket = { revision: number; generation: number }

const DATABASE = 'hapi-offline-v1'
const cachesByScope = new Map<string, OfflineCache>()

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
    })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
    const promise = new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve()
        transaction.onabort = () => reject(transaction.error ?? new Error('Cache transaction aborted'))
        transaction.onerror = () => reject(transaction.error)
    })
    void promise.catch(() => {}) // request errors may be observed before transaction abort
    return promise
}

function compare(a: Position, b: Position): number {
    return a.at - b.at || a.seq - b.seq
}

function position(at?: number | null, seq?: number | null): Position | null {
    return typeof at === 'number' && typeof seq === 'number' ? { at, seq } : null
}

/** The JWT is only used to partition local data; the hub still verifies every request. */
export function offlineScope(baseUrl: string | null, token: string): string | null {
    try {
        const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
        const claims = JSON.parse(atob(payload)) as { uid?: unknown; ns?: unknown }
        if (typeof claims.uid !== 'number' || typeof claims.ns !== 'string') return null
        const origin = new URL(baseUrl || globalThis.location.origin).origin
        return JSON.stringify([origin, claims.uid, claims.ns])
    } catch {
        return null
    }
}

export function offlineCacheFor(baseUrl: string | null, token: string): OfflineCache | null {
    const scope = offlineScope(baseUrl, token)
    if (!scope) return null
    let cache = cachesByScope.get(scope)
    if (!cache) {
        cache = new OfflineCache(scope)
        cachesByScope.set(scope, cache)
    }
    return cache
}

export function isConnectionFailure(error: unknown): boolean {
    if (error instanceof TypeError) return true // fetch network failure
    if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) return true
    const status = (error as { status?: unknown } | null)?.status
    if (status === 423 && (error as { code?: unknown }).code === 'ssh_curfew') return true
    return status === 502 || status === 503 || status === 504
}

/** Indexed rows, bounded reads and incremental writes. No transcript JSON on the UI thread. */
export class OfflineCache {
    private database: Promise<IDBDatabase> | null = null
    private pending: Promise<void> = Promise.resolve()
    private revision = 0
    private writer = crypto.randomUUID()
    private generations = new Map<string, number>()
    private offline = false
    private storageError = false
    private listeners = new Set<() => void>()

    constructor(readonly scope: string) {}

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
    }

    getStatus = (): string => this.storageError ? 'storage-error' : this.offline ? 'offline' : 'online'

    setOffline(offline: boolean): void {
        if (this.offline === offline) return
        this.offline = offline
        for (const listener of this.listeners) listener()
    }

    private failed(): void {
        if (this.storageError) return
        this.storageError = true
        for (const listener of this.listeners) listener()
    }

    private open(): Promise<IDBDatabase> {
        if (!this.database) {
            this.database = new Promise((resolve, reject) => {
                if (typeof indexedDB === 'undefined') {
                    reject(new Error('IndexedDB unavailable'))
                    return
                }
                const request = indexedDB.open(DATABASE, 1)
                request.onupgradeneeded = () => {
                    const db = request.result
                    const messages = db.createObjectStore('messages', { keyPath: ['scope', 'sessionId', 'id'] })
                    messages.createIndex('position', ['scope', 'sessionId', 'at', 'seq'])
                    messages.createIndex('reversePosition', ['scope', 'sessionId', 'reverseAt', 'reverseSeq'])
                    messages.createIndex('localId', ['scope', 'sessionId', 'message.localId'])
                    db.createObjectStore('meta', { keyPath: ['scope', 'key'] })
                }
                request.onsuccess = () => {
                    const db = request.result
                    db.onversionchange = () => { db.close(); this.database = null }
                    resolve(db)
                }
                request.onerror = () => { this.database = null; reject(request.error) }
                request.onblocked = () => reject(new Error('Offline database is blocked'))
            })
        }
        return this.database
    }

    private enqueue(action: (db: IDBDatabase) => Promise<void>): Promise<void> {
        this.pending = this.pending.then(async () => action(await this.open())).catch(() => this.failed())
        return this.pending
    }

    async flush(): Promise<void> { await this.pending }

    async close(): Promise<void> {
        await this.flush()
        if (this.database) (await this.database.catch(() => null))?.close()
        this.database = null
    }

    beginRead(sessionId: string): ReadTicket {
        return { revision: this.revision, generation: this.generations.get(sessionId) ?? 0 }
    }

    private messageRange(sessionId: string): IDBKeyRange {
        return IDBKeyRange.bound([this.scope, sessionId], [this.scope, sessionId, []])
    }

    putValue(key: string, value: unknown): Promise<void> {
        return this.enqueue(async (db) => {
            const tx = db.transaction('meta', 'readwrite')
            const done = transactionDone(tx)
            tx.objectStore('meta').put({ scope: this.scope, key, value } satisfies Meta)
            await done
        })
    }

    async getValue<T>(key: string): Promise<T | null> {
        try {
            await this.flush()
            const db = await this.open()
            const row = await requestResult(db.transaction('meta').objectStore('meta').get([this.scope, key])) as Meta | undefined
            return (row?.value as T) ?? null
        } catch {
            this.failed()
            return null
        }
    }

    getCheckpoint(sessionId: string): Promise<Checkpoint | null> {
        return this.getValue(`checkpoint:${sessionId}`)
    }

    invalidate(sessionId: string, removed = false): Promise<void> {
        this.generations.set(sessionId, (this.generations.get(sessionId) ?? 0) + 1)
        return this.enqueue(async (db) => {
            const tx = db.transaction(['messages', 'meta'], 'readwrite')
            const done = transactionDone(tx)
            tx.objectStore('messages').delete(this.messageRange(sessionId))
            const meta = tx.objectStore('meta')
            meta.delete([this.scope, `checkpoint:${sessionId}`])
            if (removed) {
                meta.delete([this.scope, `session:${sessionId}`])
                const row = await requestResult(meta.get([this.scope, 'sessions'])) as Meta | undefined
                const value = row?.value as { sessions: { id: string }[] } | undefined
                if (value) meta.put({ ...row, value: { sessions: value.sessions.filter((s) => s.id !== sessionId) } })
            }
            await done
        })
    }

    removeMessage(sessionId: string, id: string): Promise<void> {
        ++this.revision
        // Cancellation invalidates in-flight pages which could resurrect the row.
        this.generations.set(sessionId, (this.generations.get(sessionId) ?? 0) + 1)
        return this.enqueue(async (db) => {
            const tx = db.transaction('messages', 'readwrite')
            const done = transactionDone(tx)
            const store = tx.objectStore('messages')
            const row = await requestResult(store.get([this.scope, sessionId, id])) as Row | undefined
                ?? await requestResult(store.index('localId').get([this.scope, sessionId, id])) as Row | undefined
            if (row) store.delete([this.scope, sessionId, row.id])
            await done
        })
    }

    ingest(sessionId: string, messages: DecryptedMessage[]): Promise<void> {
        const revision = ++this.revision
        return this.enqueue(async (db) => {
            const tx = db.transaction('messages', 'readwrite')
            const done = transactionDone(tx)
            const store = tx.objectStore('messages')
            for (const message of messages) {
                if (typeof message.seq !== 'number') continue // never persist unsent input as delivered
                store.put({ scope: this.scope, sessionId, id: message.id, at: message.invokedAt ?? message.createdAt,
                    seq: message.seq, reverseAt: -(message.invokedAt ?? message.createdAt), reverseSeq: -message.seq,
                    revision, writer: this.writer, message } satisfies Row)
            }
            await done
        })
    }

    updateLocalIds(sessionId: string, localIds: string[], update: (message: DecryptedMessage) => DecryptedMessage): Promise<void> {
        const revision = ++this.revision
        return this.enqueue(async (db) => {
            const tx = db.transaction('messages', 'readwrite')
            const done = transactionDone(tx)
            const store = tx.objectStore('messages')
            for (const id of localIds) {
                const row = await requestResult(store.index('localId').get([this.scope, sessionId, id])) as Row | undefined
                if (!row) continue
                const message = update(row.message)
                store.put({ ...row, message, at: message.invokedAt ?? message.createdAt,
                    reverseAt: -(message.invokedAt ?? message.createdAt), revision, writer: this.writer })
            }
            await done
        })
    }

    recordPage(sessionId: string, response: MessagesResponse, ticket = this.beginRead(sessionId)): Promise<void> {
        return this.enqueue(async (db) => {
            if (ticket.generation !== (this.generations.get(sessionId) ?? 0)) return
            const tx = db.transaction(['messages', 'meta'], 'readwrite')
            const done = transactionDone(tx)
            const store = tx.objectStore('messages')
            const meta = tx.objectStore('meta')
            const key = `checkpoint:${sessionId}`
            const old = await requestResult(meta.get([this.scope, key])) as Meta | undefined
            const checkpoint = old?.value as Checkpoint | undefined
            if (checkpoint && checkpoint.epoch > response.page.epoch) { await done; return }
            if (checkpoint && checkpoint.epoch !== response.page.epoch) store.delete(this.messageRange(sessionId))

            const existingRows = await Promise.all(response.messages.map((message) => requestResult(store.get([this.scope, sessionId, message.id])))) as Array<Row | undefined>
            for (const [index, message] of response.messages.entries()) {
                if (typeof message.seq !== 'number') continue
                const existing = existingRows[index]
                // SSE may have delivered a newer revision while this HTTP request was in flight.
                if (existing && existing.writer === this.writer && existing.revision > ticket.revision) continue
                store.put({ scope: this.scope, sessionId, id: message.id, at: message.invokedAt ?? message.createdAt,
                    seq: message.seq, reverseAt: -(message.invokedAt ?? message.createdAt), reverseSeq: -message.seq,
                    revision: ticket.revision, writer: this.writer, message } satisfies Row)
            }

            const head = position(response.page.snapshotHeadAt, response.page.snapshotHeadSeq)
            const next = response.page.direction === 'after'
                ? position(response.page.nextAfterAt, response.page.nextAfterSeq) ?? checkpoint?.head ?? null
                : head
            // Before-pages and SSE never advance the durable catch-up cursor.
            if (response.page.direction !== 'before') {
                const previousHead = checkpoint?.epoch === response.page.epoch ? checkpoint.head : null
                const newest = next && previousHead && compare(previousHead, next) > 0 ? previousHead : next
                meta.put({ scope: this.scope, key, value: { epoch: response.page.epoch, head: newest } satisfies Checkpoint })
            }
            await done
        })
    }

    async readPage(sessionId: string, options: MessagePageOptions = {}): Promise<CachedMessagesResponse | null> {
        try {
            await this.flush()
            const db = await this.open()
            const tx = db.transaction(['messages', 'meta'])
            const meta = await requestResult(tx.objectStore('meta').get([this.scope, `checkpoint:${sessionId}`])) as Meta | undefined
            const checkpoint = meta?.value as Checkpoint | undefined
            // A snapshot is required to establish an authoritative epoch.
            if (!checkpoint) return null
            const limit = Math.max(1, Math.min(options.limit ?? 200, 200))
            const before = position(options.beforeAt, options.beforeSeq)
            const after = position(options.afterAt, options.afterSeq)
            const reset = options.epoch != null && options.epoch !== checkpoint.epoch
            const direction = reset ? 'latest' : before ? 'before' : after ? 'after' : 'latest'
            const until = position(options.untilAt, options.untilSeq)
            const low = direction === 'after' && after ? [this.scope, sessionId, after.at, after.seq]
                : direction === 'before' && before ? [this.scope, sessionId, -before.at, -before.seq] : [this.scope, sessionId]
            const high = direction === 'after' && until ? [this.scope, sessionId, until.at, until.seq] : [this.scope, sessionId, []]
            const range = IDBKeyRange.bound(low, high, direction !== 'latest', false)
            const index = tx.objectStore('messages').index(direction === 'after' ? 'position' : 'reversePosition')
            const rows = await requestResult(index.getAll(range, limit + 1)) as Row[]
            const messages = rows.map((row) => row.message)
            const hasMore = messages.length > limit
            if (hasMore) messages.pop()
            if (direction !== 'after') messages.reverse()
            const first = messages[0]
            const last = messages.at(-1)
            return {
                offline: true,
                messages,
                page: {
                    direction, limit, epoch: checkpoint.epoch, reset, hasMore,
                    nextBeforeAt: first ? first.invokedAt ?? first.createdAt : null,
                    nextBeforeSeq: first?.seq ?? null,
                    nextAfterAt: last ? last.invokedAt ?? last.createdAt : after?.at ?? null,
                    nextAfterSeq: last?.seq ?? after?.seq ?? null,
                    snapshotHeadAt: checkpoint.head?.at ?? null,
                    snapshotHeadSeq: checkpoint.head?.seq ?? null
                }
            }
        } catch {
            this.failed()
            return null
        }
    }
}
