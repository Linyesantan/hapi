import { createHash, randomUUID } from 'node:crypto'
import { constants, closeSync, fstatSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import type { AttachmentMetadata } from '@hapi/protocol'
import { NativeTerminalUploadRequestSchema, NativeTerminalDeleteUploadRequestSchema, type NativeTerminalRequest,
    type NativeTerminalUploadRequest, type NativeTerminalDeleteUploadRequest, type UploadFileResponse, type DeleteUploadResponse } from '@hapi/protocol/apiTypes'
import { resolveNativeTerminal } from './nativeTerminalAccess'
import type { NativeTerminalInputOptions } from './nativeTerminalInput'

const MAX_BYTES = 50 * 1024 * 1024
type Manifest = { filename: string; mimeType: string; size: number; dev: number; ino: number }

export function nativeUploadDirectory(request: NativeTerminalRequest, options: NativeTerminalInputOptions) {
    const key = createHash('sha256').update(`${request.agent}\0${request.sessionId}`).digest('hex')
    return join(options.receiptsDir, key, 'uploads')
}

function inspectUpload(request: NativeTerminalRequest, path: string, options: NativeTerminalInputOptions): Manifest {
    const directory = nativeUploadDirectory(request, options)
    if (dirname(resolve(path)) !== resolve(directory) || !/^[a-f0-9-]{36}\.[a-z0-9]{1,12}$/.test(basename(path))) throw new Error('附件不属于当前会话，请重新选择文件。')
    if (realpathSync(path) !== resolve(path)) throw new Error('附件路径已变化，请重新上传。')
    const manifest = JSON.parse(readFileSync(`${path}.json`, 'utf8')) as Manifest
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
        const info = fstatSync(fd)
        if (!info.isFile() || info.size > MAX_BYTES || info.size !== manifest.size || info.dev !== manifest.dev || info.ino !== manifest.ino) throw new Error('附件已变化，请重新上传。')
    } finally { closeSync(fd) }
    return manifest
}

export function validateNativeAttachments(request: NativeTerminalRequest, attachments: AttachmentMetadata[] | undefined, options: NativeTerminalInputOptions) {
    return (attachments ?? []).map(attachment => {
        const info = inspectUpload(request, attachment.path, options)
        return { ...attachment, filename: info.filename, mimeType: info.mimeType, size: info.size }
    })
}

export async function uploadNativeTerminalFile(input: NativeTerminalUploadRequest, options: NativeTerminalInputOptions): Promise<UploadFileResponse> {
    const parsed = NativeTerminalUploadRequestSchema.safeParse(input)
    if (!parsed.success) return { success: false, error: '无效的附件。' }
    const request = parsed.data
    const { target } = await resolveNativeTerminal(request, options)
    if (!target) return { success: false, error: '原终端暂未连接，请恢复连接后重试上传。' }
    try {
        if (request.content.length % 4 || /[^A-Za-z0-9+/=]/.test(request.content)
            || /=/.test(request.content.slice(0, -2)) || /=[^=]$/.test(request.content)) throw new Error('附件数据不完整，请重新上传。')
        const bytes = Buffer.from(request.content, 'base64')
        if (bytes.length > MAX_BYTES) throw new Error('文件超过 50 MB，请选择更小的文件。')
        const directory = nativeUploadDirectory(request, options)
        mkdirSync(directory, { recursive: true, mode: 0o700 })
        const imageExtensions: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/bmp': 'bmp' }
        const extension = imageExtensions[request.mimeType] ?? extname(request.filename).slice(1).toLowerCase()
        const path = join(directory, `${randomUUID()}.${/^[a-z0-9]{1,12}$/.test(extension) ? extension : 'bin'}`)
        writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 })
        const info = statSync(path)
        const manifest: Manifest = { filename: request.filename.replace(/[\x00-\x1f\x7f]/g, '_'), mimeType: request.mimeType,
            size: bytes.length, dev: info.dev, ino: info.ino }
        try { writeFileSync(`${path}.json`, JSON.stringify(manifest), { flag: 'wx', mode: 0o600 }) }
        catch (error) { unlinkSync(path); throw error }
        return { success: true, path }
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : '上传失败，请重试。' } }
}

export async function deleteNativeTerminalUpload(input: NativeTerminalDeleteUploadRequest, options: NativeTerminalInputOptions): Promise<DeleteUploadResponse> {
    const parsed = NativeTerminalDeleteUploadRequestSchema.safeParse(input)
    if (!parsed.success) return { success: false, error: '无效的附件。' }
    const { target } = await resolveNativeTerminal(parsed.data, options)
    if (!target) return { success: false, error: '原终端暂未连接。' }
    try {
        inspectUpload(parsed.data, parsed.data.path, options)
        // Deleting an unsent chip must not invalidate a persisted queue entry.
        const { readdirSync } = await import('node:fs')
        for (const name of readdirSync(dirname(nativeUploadDirectory(parsed.data, options)))) {
            if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue
            const record = JSON.parse(readFileSync(join(dirname(nativeUploadDirectory(parsed.data, options)), name), 'utf8'))
            if (record.status !== 'cancelled' && record.status !== 'rejected'
                && record.attachments?.some((item: AttachmentMetadata) => item.path === parsed.data.path)) return { success: true }
        }
        unlinkSync(parsed.data.path); unlinkSync(`${parsed.data.path}.json`)
        return { success: true }
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { success: true }
            : { success: false, error: '无法删除该附件，请刷新后重试。' }
    }
}
