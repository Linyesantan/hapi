import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { AttachmentMetadataSchema, type AttachmentMetadata } from '@hapi/protocol/schemas'
import type { NativeTerminalRequest } from '@hapi/protocol/apiTypes'
import { configuration } from '@/configuration'

/** Reattach previews only when the native message identifies the uploaded file. */
export function nativeAttachmentHistory(request: NativeTerminalRequest, receiptsDir = join(configuration.happyHomeDir, 'native-terminal-input')) {
    const directory = join(receiptsDir, createHash('sha256').update(`${request.agent}\0${request.sessionId}`).digest('hex'))
    const entries: { wireText: string; attachments: AttachmentMetadata[]; imagePaths: string[] }[] = []
    try {
        for (const name of readdirSync(directory)) {
            if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue
            try {
                const record = JSON.parse(readFileSync(join(directory, name), 'utf8'))
                if (record.status === 'queued' || record.status === 'cancelled' || record.status === 'rejected' || typeof record.wireText !== 'string') continue
                const attachments = AttachmentMetadataSchema.array().safeParse(record.attachments)
                if (attachments.success && attachments.data.length) entries.push({ wireText: record.wireText, attachments: attachments.data,
                    imagePaths: Array.isArray(record.imagePaths) ? record.imagePaths.filter((path: unknown) => typeof path === 'string') : [] })
            } catch { /* A damaged optional preview cannot break native history. */ }
        }
    } catch { /* No uploaded attachments for this native session. */ }
    const normalize = (text: string) => text.replace(/\[Image\s+#?\d+\]|\[附件:[^\]]+\]/g, '').trim()
    return (text: string, imageIdentifiers: string[] = []): AttachmentMetadata[] | undefined => {
        const candidates = entries.filter(entry => normalize(text) === normalize(entry.wireText)
            && entry.attachments.every(item => entry.imagePaths.includes(item.path)
                ? imageIdentifiers.includes(item.path) || imageIdentifiers.includes(basename(item.path))
                : text.includes(item.path)))
        return candidates.length === 1 ? candidates[0].attachments : undefined
    }
}
