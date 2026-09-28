import { useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { AttachmentMetadata } from '@/types/api'
import { FileIcon } from '@/components/FileIcon'

export function AttachmentFilePreview(props: { attachment: Pick<AttachmentMetadata, 'filename' | 'mimeType' | 'size' | 'previewText' | 'previewTruncated'> }) {
    const [open, setOpen] = useState(false)
    const item = props.attachment
    const size = item.size >= 1024 * 1024 ? `${(item.size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(item.size / 1024))} KB`
    return <>
        <button type="button" onClick={() => setOpen(true)} aria-label={`预览 ${item.filename}`} className="flex min-w-0 items-center gap-2 text-left">
            <FileIcon fileName={item.filename} size={20} />
            <span className="min-w-0"><span className="block max-w-48 truncate text-sm">{item.filename}</span><span className="text-xs text-[var(--app-hint)]">{size} · 点击预览</span></span>
        </button>
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent className="max-w-2xl">
                <DialogHeader><DialogTitle className="break-all">{item.filename}</DialogTitle><DialogDescription>{item.mimeType} · {size}</DialogDescription></DialogHeader>
                {item.previewText !== undefined ? <div><pre data-hapi-nested-scroll="true" className="max-h-[60dvh] overflow-auto whitespace-pre-wrap break-words rounded bg-[var(--app-subtle-bg)] p-3 text-sm">{item.previewText || '空文件'}</pre>{item.previewTruncated ? <p className="mt-2 text-xs text-[var(--app-hint)]">这里只显示文件开头，发送时会附上完整文件。</p> : null}</div>
                    : <p className="text-sm text-[var(--app-hint)]">此格式暂不支持内容预览。文件会完整发送给终端。</p>}
            </DialogContent>
        </Dialog>
    </>
}
