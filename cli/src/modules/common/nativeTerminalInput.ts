import { createHash, randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { NativeTerminalReceiptSchema, NativeTerminalSendRequestSchema, type NativeCodexTerminalState, type NativeTerminalReceipt, type NativeTerminalRequest, type NativeTerminalSendRequest, type NativeTerminalSendResponse } from '@hapi/protocol/apiTypes'
import { nativeComposerText, nativeTmuxCondition, readNativeTerminalSnapshot, runNativeTmux, type NativeTerminalOptions, type NativeTerminalTarget } from './nativeTerminalAccess'
import { validateNativeAttachments } from './nativeTerminalUploads'

export type NativeTerminalInputOptions = NativeTerminalOptions & { receiptsDir: string }
type Options = NativeTerminalInputOptions
export type NativeTerminalRecord = NativeTerminalReceipt & NativeTerminalRequest & {
    binding: string; file: string; cwd: string; offset: number; wireText?: string; imagePaths?: string[]; immediate?: boolean
}
type RecordEntry = NativeTerminalRecord
const locks = new Map<string, Promise<void>>()
const keyFor = (request: NativeTerminalRequest) => createHash('sha256').update(`${request.agent}\0${request.sessionId}`).digest('hex')
export const nativeTerminalDirectory = (request: NativeTerminalRequest, options: Options) => join(options.receiptsDir, keyFor(request))
const directoryFor = nativeTerminalDirectory
const pathFor = (request: NativeTerminalSendRequest, options: Options) => join(directoryFor(request, options), `${request.requestId}.json`)
const receiptFor = (record: RecordEntry): NativeTerminalReceipt => NativeTerminalReceiptSchema.parse(record)

export function saveNativeTerminalRecord(path: string, record: unknown, exclusive = false) {
    const target = exclusive ? path : `${path}.${randomUUID()}.tmp`
    const fd = openSync(target, 'wx', 0o600)
    try { writeFileSync(fd, JSON.stringify(record)); fsyncSync(fd) } finally { closeSync(fd) }
    if (!exclusive) renameSync(target, path)
    const dir = openSync(join(path, '..'), 'r')
    try { fsyncSync(dir) } finally { closeSync(dir) }
}
const saveRecord = saveNativeTerminalRecord

export function readNativeTerminalRecord(path: string): RecordEntry | undefined {
    try {
        const record = JSON.parse(readFileSync(path, 'utf8')) as RecordEntry
        if (!NativeTerminalReceiptSchema.safeParse(record).success || !['codex', 'opencode'].includes(record.agent)
            || typeof record.sessionId !== 'string' || typeof record.binding !== 'string' || typeof record.file !== 'string'
            || typeof record.cwd !== 'string' || !Number.isSafeInteger(record.offset) || record.offset < 0) throw new Error('Invalid native receipt')
        return record
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error // A damaged ledger must never turn an uncertain write into a new write.
    }
}
const readRecord = readNativeTerminalRecord

async function baseline(target: NativeTerminalTarget) {
    if (target.agent === 'codex') return statSync(target.file).size
    const { Database } = await import('bun:sqlite')
    const db = new Database(target.file, { readonly: true })
    try { return db.query<{ offset: number }, []>('SELECT COALESCE(MAX(rowid), 0) AS offset FROM message').get()?.offset ?? 0 } finally { db.close() }
}

async function isConfirmed(record: RecordEntry): Promise<boolean> {
    if (record.agent === 'codex') {
        const remaining = statSync(record.file).size - record.offset
        if (remaining <= 0 || remaining > 4 * 1024 * 1024) return false
        const fd = openSync(record.file, 'r')
        const bytes = Buffer.alloc(remaining)
        try { readSync(fd, bytes, 0, remaining, record.offset) } finally { closeSync(fd) }
        return bytes.toString('utf8').split('\n').slice(0, -1).some(line => {
            try {
                const item = JSON.parse(line)
                if (item.type === 'response_item' && item.payload?.type === 'message' && item.payload?.role === 'user') {
                    // Newer Codex versions no longer emit event_msg/user_message
                    // records; the submitted turn lands in the transcript as a
                    // response_item user message with input_text parts.
                    const parts = Array.isArray(item.payload.content) ? item.payload.content as Array<{ type?: string; text?: unknown }> : []
                    const text = parts.filter(part => part?.type === 'input_text')
                        .map(part => String(part.text ?? '')).join('\n')
                    return text.replace(/\[Image\s+#?\d+\]/g, '').trim() === (record.wireText ?? record.text).trim()
                }
                if (item.type !== 'event_msg' || item.payload?.type !== 'user_message') return false
                const text = String(item.payload.message ?? '').replace(/\[Image\s+#?\d+\]/g, '').trim()
                if (text !== (record.wireText ?? record.text).trim()) return false
                return !record.imagePaths?.length || record.imagePaths.every(path => (item.payload.local_images ?? []).includes(path))
            } catch { return false }
        })
    }
    const { Database } = await import('bun:sqlite')
    const db = new Database(record.file, { readonly: true })
    try {
        const parts = db.query<{ message_id: string; text: string }, [string, number]>(`
            SELECT p.message_id, json_extract(p.data, '$.text') AS text FROM message m JOIN part p ON p.message_id = m.id
            WHERE m.session_id = ? AND m.rowid > ? AND json_extract(m.data, '$.role') = 'user'
              AND json_extract(p.data, '$.type') = 'text'
              AND COALESCE(json_extract(p.data, '$.synthetic'), 0) = 0
            ORDER BY m.rowid, p.time_created, p.id
        `).all(record.sessionId, record.offset)
        const messages = new Map<string, string[]>()
        for (const part of parts) messages.set(part.message_id, [...(messages.get(part.message_id) ?? []), part.text])
        return [...messages.values()].some(texts => texts.join('\n').replace(/\[Image\s+#?\d+\]/g, '').trim() === (record.wireText ?? record.text).trim())
    } finally { db.close() }
}

async function reconcile(path: string, record: RecordEntry) {
    if (record.status === 'submitted' || record.status === 'indeterminate') {
        try {
            if (await isConfirmed(record)) {
                record = { ...record, status: 'confirmed', note: '原会话已收到这条消息。' }
                saveRecord(path, record)
            }
        } catch { /* A temporarily unavailable transcript is not a failed send. */ }
    }
    return record
}

export async function readNativeTerminal(request: NativeTerminalRequest, options: Options): Promise<NativeCodexTerminalState> {
    const { state } = await readNativeTerminalSnapshot(request, options)
    const directory = directoryFor(request, options)
    const submissions: NativeTerminalReceipt[] = []
    try {
        for (const name of readdirSync(directory).filter(name => /^[a-f0-9-]{36}\.json$/.test(name))) {
            const path = join(directory, name)
            let record = readRecord(path)
            if (!record || options.canRead && !await options.canRead(record)) continue
            record = await reconcile(path, record)
            if (record.status !== 'confirmed' && record.status !== 'cancelled') submissions.push(receiptFor(record))
        }
    } catch { /* The input ledger may not exist until the first submission. */ }
    state.submissions = submissions.sort((a, b) => a.createdAt - b.createdAt)
    return state
}

async function send(request: NativeTerminalSendRequest, options: Options): Promise<NativeTerminalSendResponse> {
    const path = pathFor(request, options)
    const previous = readRecord(path)
    if (previous) {
        const attachmentsKey = (items: NativeTerminalReceipt['attachments']) => JSON.stringify((items ?? []).map(item => [item.id, item.path]))
        if (previous.text !== request.text || previous.binding !== request.binding
            || attachmentsKey(previous.attachments) !== attachmentsKey(request.attachments)) return { success: false, error: '该发送编号已用于另一条消息。' }
        if (options.canRead && !await options.canRead(previous)) return { success: false, error: 'Path is outside workspace roots' }
        return { success: true, receipt: receiptFor(await reconcile(path, previous)) }
    }
    let snapshot = await readNativeTerminalSnapshot(request, options)
    if (!snapshot.target || snapshot.target.binding !== request.binding) return { success: false, error: '原终端或会话已变化，请刷新后重新发送。' }
    let attachments: NonNullable<NativeTerminalReceipt['attachments']>
    try { attachments = validateNativeAttachments(request, request.attachments, options) }
    catch (error) { return { success: false, error: error instanceof Error ? error.message : '附件已失效，请重新上传。' } }
    const images = attachments.filter(item => /^image\/(png|jpe?g|webp|gif|bmp)$/.test(item.mimeType))
    const files = attachments.filter(item => !images.includes(item))
    const wireText = [request.text, files.length ? '附件已保存到本机，请按需读取：\n' + files.map(item => `${JSON.stringify(item.filename)}：${item.path}`).join('\n') : ''].filter(Boolean).join('\n\n')
        || '请查看附件。'
    const target = snapshot.target
    const record: RecordEntry = { ...request, attachments: attachments.length ? attachments : undefined,
        binding: request.binding, file: target.file, cwd: target.cwd, offset: await baseline(target), createdAt: Date.now(),
        wireText, imagePaths: images.map(item => item.path), status: 'queued', note: '等待原终端空闲；可删除或立即发送。' }
    mkdirSync(directoryFor(request, options), { recursive: true, mode: 0o700 })
    if (request.delivery === 'queue' && (snapshot.state.busy || !snapshot.state.input?.available)) {
        saveRecord(path, record, true)
        return { success: true, receipt: receiptFor(record) }
    }
    if (!snapshot.state.input?.available) return { success: false, error: snapshot.state.input?.reason ?? '原终端暂时不能输入。' }
    return deliverNativeTerminalRecord(record, options)
}

/** Caller holds the native terminal lock. A durable write precedes every paste. */
export async function deliverNativeTerminalRecord(record: RecordEntry, options: Options): Promise<NativeTerminalSendResponse> {
    const request = record
    const path = pathFor(record, options)
    let snapshot = await readNativeTerminalSnapshot(record, options)
    if (!snapshot.target || snapshot.target.binding !== record.binding || !snapshot.state.input?.available) {
        return { success: false, error: snapshot.state.input?.reason ?? '原终端尚未就绪。' }
    }
    validateNativeAttachments(record, record.attachments, options)
    const run = options.run ?? runNativeTmux
    const buffer = `hapi-input-${request.requestId}`
    const target = snapshot.target
    // The named buffer is private to this submission; neither shell quoting nor
    // the operator's default paste buffer is involved in transporting the text.
    await run(['-S', target.socket, 'load-buffer', '-b', buffer, '-'], record.wireText ?? record.text)
    try {
        snapshot = await readNativeTerminalSnapshot(request, options)
        if (!snapshot.target || snapshot.target.binding !== request.binding || !snapshot.state.input?.available) {
            return { success: false, error: snapshot.state.input?.reason ?? '原终端的输入状态已变化，请重试。' }
        }
        record.offset = await baseline(target)
        record.status = 'indeterminate'
        record.note = '发送结果待确认；不会自动重复发送，请核对原终端和会话记录。'
        mkdirSync(directoryFor(request, options), { recursive: true, mode: 0o700 })
        saveRecord(path, record)
        // Evaluate the foreground process and pane once more inside tmux's
        // command queue. Never exit copy mode, erase a draft, resize or restart.
        const condition = nativeTmuxCondition(target)
        try {
            for (const [index, imagePath] of (record.imagePaths ?? []).entries()) {
                const imageBuffer = `${buffer}-image`
                await run(['-S', target.socket, 'load-buffer', '-b', imageBuffer, '-'], imagePath)
                const pasted = await run(['-S', target.socket, 'if-shell', '-F', '-t', target.pane, condition,
                    `paste-buffer -p -r -d -b ${imageBuffer} -t ${target.pane} ; display-message -p HAPI_IMAGE_SENT`, 'display-message -p HAPI_IMAGE_REJECTED'])
                if (pasted.trim() !== 'HAPI_IMAGE_SENT') throw new Error('Image paste not confirmed')
                let attached = false
                for (let attempt = 0; attempt < 50; attempt++) {
                    snapshot = await readNativeTerminalSnapshot(record, options)
                    if (!snapshot.target || snapshot.target.binding !== record.binding) break
                    const composer = nativeComposerText(snapshot.target, snapshot.raw)
                    if (composer && (composer.match(/\[Image\s+#?\d+\]/g)?.length ?? 0) >= index + 1) { attached = true; break }
                    await new Promise(resolve => setTimeout(resolve, 40))
                }
                if (!attached) {
                    record.note = '图片尚未被原终端确认，未提交消息；附件和草稿保留，请查看原终端。'
                    saveRecord(path, record)
                    return { success: true, receipt: receiptFor(record) }
                }
            }
            // OpenCode reads pasted images/text asynchronously. Let its paste
            // handler finish before Enter; adjacent paste+Enter can be lost.
            const separateSubmit = request.agent === 'opencode' || Boolean(record.imagePaths?.length)
            const result = await run(['-S', target.socket, 'if-shell', '-F', '-t', target.pane, condition,
                `paste-buffer -p -r -d -b ${buffer} -t ${target.pane} ; ${separateSubmit ? '' : `send-keys -t ${target.pane} Enter ; `}display-message -p HAPI_INPUT_SENT`,
                'display-message -p HAPI_INPUT_REJECTED'])
            if (result.trim() === 'HAPI_INPUT_SENT') {
                if (separateSubmit) {
                    await new Promise(resolve => setTimeout(resolve, 160))
                    const ready = await readNativeTerminalSnapshot(record, options)
                    if (!ready.target || ready.target.binding !== record.binding || ready.state.modelMenu) throw new Error('Terminal changed before submit')
                    const entered = await run(['-S', target.socket, 'if-shell', '-F', '-t', target.pane, condition,
                        `send-keys -t ${target.pane} Enter ; display-message -p HAPI_INPUT_SENT`, 'display-message -p HAPI_INPUT_REJECTED'])
                    if (entered.trim() !== 'HAPI_INPUT_SENT') throw new Error('Submit not confirmed')
                }
                record.status = 'submitted'; record.note = '已送入原终端，等待会话记录确认。'
            } else if (result.trim() === 'HAPI_INPUT_REJECTED') {
                record.status = 'rejected'; record.note = '终端状态已变化，这条消息没有发送。'
            }
            saveRecord(path, record)
        } catch { /* The persisted indeterminate receipt prevents replay. */ }
        return { success: true, receipt: receiptFor(record) }
    } finally {
        try { await run(['-S', target.socket, 'delete-buffer', '-b', buffer]) } catch { /* paste-buffer -d already removed it */ }
    }
}

export async function drainNativeTerminalQueue(options: Options): Promise<void> {
    let directories: string[]
    try { directories = readdirSync(options.receiptsDir).filter(name => /^[a-f0-9]{64}$/.test(name)) } catch { return }
    for (const directory of directories) {
        const records = readdirSync(join(options.receiptsDir, directory)).filter(name => /^[a-f0-9-]{36}\.json$/.test(name))
            .flatMap(name => { try { const record = readRecord(join(options.receiptsDir, directory, name)); return record?.status === 'queued' ? [record] : [] } catch { return [] } })
            .sort((a, b) => Number(Boolean(b.immediate)) - Number(Boolean(a.immediate)) || a.createdAt - b.createdAt)
        const first = records[0]
        if (!first) continue
        await withNativeTerminalLock(first, options, async () => {
            const record = readRecord(pathFor(first, options))
            if (record?.status !== 'queued') return
            if (options.canRead && !await options.canRead(record)) return
            const snapshot = await readNativeTerminalSnapshot(record, options)
            if (!snapshot.target || snapshot.target.binding !== record.binding || snapshot.state.busy || !snapshot.state.input?.available) return
            try { await deliverNativeTerminalRecord(record, options) } catch { /* Keep a never-dispatched queue item for retry. */ }
        })
    }
}

export async function sendNativeTerminalInput(input: NativeTerminalSendRequest, options: Options): Promise<NativeTerminalSendResponse> {
    const parsed = NativeTerminalSendRequestSchema.safeParse(input)
    if (!parsed.success) return { success: false, error: '无效的终端输入，请使用不含控制字符的普通文本。' }
    return withNativeTerminalLock(parsed.data, options, async () => {
        try { return await send(parsed.data, options) }
        catch { return { success: true, receipt: { requestId: parsed.data.requestId, text: parsed.data.text, createdAt: Date.now(), status: 'indeterminate',
            note: '暂时无法核对发送记录；保留草稿并用同一请求重试，不会自动重新投递。' } } }
    })
}

export async function withNativeTerminalLock<T>(request: NativeTerminalRequest, options: Options, action: () => Promise<T>): Promise<T> {
    const key = directoryFor(request, options)
    const prior = locks.get(key) ?? Promise.resolve()
    let release!: () => void
    const next = new Promise<void>(resolve => { release = resolve })
    locks.set(key, next)
    await prior
    try { return await action() }
    finally { release(); if (locks.get(key) === next) locks.delete(key) }
}
