import type { AttachmentAdapter, PendingAttachment, CompleteAttachment, Attachment } from '@assistant-ui/react'
import type { ApiClient } from '@/api/client'
import type { AttachmentMetadata } from '@/types/api'
import { isImageMimeType } from '@/lib/fileAttachments'
import { attachmentMimeType, largeImagePreview, textAttachmentPreview } from '@/lib/attachmentPreview'
import { randomId } from '@/lib/randomId'
import { apiErrorMessage } from '@/lib/apiErrorMessage'
import { getRestoredUploadMetadata } from '@/lib/composer-attachment-drafts'
import type { AttachmentDraftHandoff } from '@/lib/composer-draft-transfer'

/** Composer / share upload ceiling — keep deep-link fetch in sync. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024
const MAX_PREVIEW_BYTES = 160 * 1024

type PendingUploadAttachment = PendingAttachment & {
    path?: string
    previewUrl?: string
    uploadSessionId?: string
    previewText?: string
    previewTruncated?: boolean
    errorMessage?: string
}

export function createAttachmentAdapter(
    api: Pick<ApiClient, 'uploadFile' | 'deleteUploadFile'>,
    sessionId: string,
    resolveSessionId?: () => Promise<string>,
    // Always hand off after resume merges into a new session id — even when
    // the pick is cancelled — so the caller can navigate off a deleted source.
    // Cancellation is re-checked at transfer save time via isCancelled().
    onSessionResolved?: (sessionId: string, pending: AttachmentDraftHandoff) => Promise<void>,
): AttachmentAdapter {
    const cancelledAttachmentIds = new Set<string>()

    const deleteUpload = async (path?: string, uploadSessionId = sessionId) => {
        if (!path) return
        try {
            await api.deleteUploadFile(uploadSessionId, path)
        } catch {
            // Best effort cleanup
        }
    }

    return {
        // assistant-ui uses the exact "*" sentinel for an allow-all adapter.
        // "*/*" is forwarded to MIME matching and rejects every file before
        // this adapter's add() method can run.
        accept: '*',

        async *add({ file }): AsyncGenerator<PendingAttachment> {
            // Upload paths are scoped to the session that created them. An
            // inactive composer may resume into a different session id, so its
            // persisted file must follow the normal resolve/transfer flow and
            // be uploaded again by the resumed composer. Pathless restored
            // metadata still supplies a stable id so draft merge cannot
            // duplicate the same File across persistence passes.
            const restored = getRestoredUploadMetadata(file)
            if (!resolveSessionId && restored?.path) {
                yield {
                    id: restored.id,
                    type: 'file',
                    name: file.name,
                    contentType: attachmentMimeType(file),
                    file,
                    status: { type: 'requires-action', reason: 'composer-send' },
                    path: restored.path,
                    previewUrl: restored.previewUrl,
                    uploadSessionId: restored.uploadSessionId,
                    ...await textAttachmentPreview(file, attachmentMimeType(file)),
                } as PendingUploadAttachment
                return
            }

            const id = restored?.id ?? randomId()
            const contentType = attachmentMimeType(file)
            let previewUrl: string | undefined
            let textPreview: { previewText?: string; previewTruncated?: boolean } = {}

            try {
                let originalDataUrl: string | undefined
                if (isImageMimeType(contentType) && file.size <= MAX_PREVIEW_BYTES) {
                    try {
                        originalDataUrl = await fileToDataUrl(file)
                        previewUrl = originalDataUrl.replace(/^data:[^;,]*;/, `data:${contentType};`)
                    } catch {
                        // Preview generation is optional; retry the read for the upload payload below.
                    }
                } else if (isImageMimeType(contentType) && file.size <= MAX_UPLOAD_BYTES) {
                    previewUrl = await largeImagePreview(file)
                }
                textPreview = await textAttachmentPreview(file, contentType)

                yield {
                    id,
                    type: 'file',
                    name: file.name,
                    contentType,
                    file,
                    status: { type: 'running', reason: 'uploading', progress: 0 },
                    previewUrl, ...textPreview
                } as PendingUploadAttachment

                if (cancelledAttachmentIds.has(id)) {
                    return
                }

                if (file.size > MAX_UPLOAD_BYTES) {
                    yield {
                        id,
                        type: 'file',
                        name: file.name,
                        contentType,
                        file,
                        status: { type: 'incomplete', reason: 'error' },
                        errorMessage: '文件超过 50 MB，请选择更小的文件。'
                    } as PendingUploadAttachment
                    return
                }

                const uploadSessionId = resolveSessionId ? await resolveSessionId() : sessionId
                // Resume may already have merged the source session away. Always
                // hand off with a live cancellation predicate so transfer can
                // drop this id (even if already persisted on the source draft).
                if (uploadSessionId !== sessionId && onSessionResolved) {
                    await onSessionResolved(uploadSessionId, {
                        id,
                        file,
                        previewUrl,
                        isCancelled: () => cancelledAttachmentIds.has(id),
                    })
                    return
                }
                if (cancelledAttachmentIds.has(id)) {
                    return
                }

                const content = originalDataUrl
                    ? base64FromDataUrl(originalDataUrl)
                    : await fileToBase64(file)

                if (cancelledAttachmentIds.has(id)) {
                    return
                }

                yield {
                    id,
                    type: 'file',
                    name: file.name,
                    contentType,
                    file,
                    status: { type: 'running', reason: 'uploading', progress: 50 },
                    previewUrl, ...textPreview
                } as PendingUploadAttachment

                const result = await api.uploadFile(uploadSessionId, file.name, content, contentType)
                if (cancelledAttachmentIds.has(id)) {
                    if (result.success && result.path) {
                        await deleteUpload(result.path, uploadSessionId)
                    }
                    return
                }

                if (!result.success || !result.path) {
                    yield {
                        id,
                        type: 'file',
                        name: file.name,
                        contentType,
                        file,
                        status: { type: 'incomplete', reason: 'error' }, previewUrl, ...textPreview,
                        errorMessage: result.error || '上传失败，请重新选择文件。'
                    } as PendingUploadAttachment
                    return
                }

                yield {
                    id,
                    type: 'file',
                    name: file.name,
                    contentType,
                    file,
                    status: { type: 'requires-action', reason: 'composer-send' },
                    path: result.path,
                    previewUrl,
                    ...textPreview,
                    uploadSessionId,
                } as PendingUploadAttachment

            } catch (error) {
                yield {
                    id,
                    type: 'file',
                    name: file.name,
                    contentType,
                    file,
                    status: { type: 'incomplete', reason: 'error' }, previewUrl, ...textPreview,
                    errorMessage: apiErrorMessage(error, '上传失败，请重新选择文件。')
                } as PendingUploadAttachment
            }
        },

        async remove(attachment: Attachment): Promise<void> {
            cancelledAttachmentIds.add(attachment.id)
            const path = (attachment as PendingUploadAttachment).path
            const uploadSessionId = (attachment as PendingUploadAttachment).uploadSessionId
            await deleteUpload(path, uploadSessionId)
        },

        async send(attachment: PendingAttachment): Promise<CompleteAttachment> {
            const pending = attachment as PendingUploadAttachment
            const path = pending.path
            if (!path) throw new Error('附件还没有上传成功，请重试。')

            // Build AttachmentMetadata to be sent with the message
            const metadata: AttachmentMetadata | undefined = path ? {
                id: attachment.id,
                filename: attachment.name,
                mimeType: attachment.contentType ?? 'application/octet-stream',
                size: attachment.file?.size ?? 0,
                path,
                previewUrl: pending.previewUrl,
                previewText: pending.previewText,
                previewTruncated: pending.previewTruncated
            } : undefined

            return {
                id: attachment.id,
                type: attachment.type,
                name: attachment.name,
                contentType: attachment.contentType,
                status: { type: 'complete' },
                // Store metadata as JSON in the text content for extraction by assistant-runtime
                content: metadata ? [{ type: 'text', text: JSON.stringify({ __attachmentMetadata: metadata }) }] : []
            }
        }
    }
}

async function fileToBase64(file: File): Promise<string> {
    return base64FromDataUrl(await fileToDataUrl(file))
}

function base64FromDataUrl(dataUrl: string): string {
    const separatorIndex = dataUrl.indexOf(',')
    const base64 = separatorIndex >= 0 ? dataUrl.slice(separatorIndex + 1) : ''
    if (!base64) {
        throw new Error('Failed to read file')
    }
    return base64
}

async function fileToDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => {
            resolve(reader.result as string)
        }
        reader.onerror = reject
        reader.readAsDataURL(file)
    })
}
