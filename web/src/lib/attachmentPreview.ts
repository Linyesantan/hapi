export const MAX_TEXT_PREVIEW = 12_000

export function attachmentMimeType(file: File): string {
    if (file.type && file.type !== 'application/octet-stream') return file.type
    const extension = file.name.split('.').at(-1)?.toLowerCase() ?? ''
    const images: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml' }
    return images[extension] ?? (/^(txt|md|log|csv|json|yaml|yml|toml|ini|conf|py|js|ts|tsx|jsx|rs|go|c|h|css|html|xml|sh)$/.test(extension)
        ? 'text/plain' : extension === 'pdf' ? 'application/pdf' : 'application/octet-stream')
}

export async function textAttachmentPreview(file: File, mimeType: string): Promise<{ previewText?: string; previewTruncated?: boolean }> {
    if (!/^text\/|^application\/(json|xml|yaml)/.test(mimeType)) return {}
    try {
        const text = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader()
            reader.onload = () => resolve(String(reader.result ?? ''))
            reader.onerror = reject
            reader.readAsText(file.slice(0, MAX_TEXT_PREVIEW * 4))
        })
        if (text.includes('\0')) return {}
        return { previewText: text.slice(0, MAX_TEXT_PREVIEW), previewTruncated: text.length > MAX_TEXT_PREVIEW || file.size > MAX_TEXT_PREVIEW * 4 }
    } catch { return {} }
}

/** A small offline thumbnail; the original bytes are always uploaded separately. */
export async function largeImagePreview(file: File): Promise<string | undefined> {
    if (typeof createImageBitmap !== 'function') return undefined
    let bitmap: ImageBitmap | undefined
    try {
        bitmap = await createImageBitmap(file)
        const scale = Math.min(1, 960 / Math.max(bitmap.width, bitmap.height))
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale))
        const context = canvas.getContext('2d')
        if (!context) return undefined
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
        for (const quality of [0.8, 0.6, 0.4]) {
            const preview = canvas.toDataURL('image/webp', quality)
            if (preview.length <= 240_000) return preview
        }
        return undefined
    } catch { return undefined }
    finally { bitmap?.close() }
}
