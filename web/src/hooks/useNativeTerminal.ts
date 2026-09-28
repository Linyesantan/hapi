import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useRef, useState } from 'react'
import { NativeTerminalInputSchema, type NativeTerminalInput, type NativeTerminalRequest } from '@hapi/protocol/apiTypes'
import type { AttachmentMetadata } from '@/types/api'
import { getPhoneCurfew } from '@hapi/protocol/phoneCurfew'
import type { ApiClient } from '@/api/client'
import type { ComposerSendError } from '@/components/AssistantChat/HappyComposer'
import type { SendMessageSettlement } from '@/hooks/mutations/useSendMessage'
import { useOnlineStatus } from '@/hooks/useOnlineStatus'
import { queryKeys } from '@/lib/query-keys'
import { apiErrorMessage } from '@/lib/apiErrorMessage'

export function useNativeTerminal(api: ApiClient | null, request: NativeTerminalRequest | null, machineId?: string | null) {
    const online = useOnlineStatus()
    const query = useQuery({
        queryKey: queryKeys.nativeTerminal(request?.agent ?? '', request?.sessionId ?? '', machineId),
        queryFn: async () => {
            if (!api || !request) throw new Error('网关未连接')
            const result = await api.getNativeTerminal(request, machineId)
            if (!result.success) throw new Error(result.error)
            return result.state
        },
        enabled: Boolean(api && request), networkMode: 'always',
        refetchInterval: 2_000, staleTime: 1_000, retry: false
    })
    const stale = !online || Boolean(query.error) || !query.data || Date.now() - query.data.checkedAt > 10_000
    return { ...query, stale, canSend: !stale && Boolean(query.data?.input?.available) && !getPhoneCurfew().restricted }
}

/** An uncertain request keeps its ID across remounts and network retries. */
export function useNativeTerminalSend(api: ApiClient, sessionId: string) {
    const client = useQueryClient()
    const busy = useRef(false)
    const [isSending, setIsSending] = useState(false)
    const [error, setError] = useState<ComposerSendError | null>(null)
    const [settlement, setSettlement] = useState<SendMessageSettlement | null>(null)
    const storageKey = `hapi.native-input.v1.${sessionId}`
    const pending = useRef<NativeTerminalInput | null>(null)
    const clearError = useCallback(() => setError(null), [])
    const send = useCallback(async (text: string, binding?: string, blockedReason?: string, attachments?: AttachmentMetadata[], delivery?: 'queue' | 'immediate') => {
        if (busy.current) return false
        busy.current = true
        setIsSending(true)
        setError(null)
        let input: NativeTerminalInput | undefined
        try {
            if (getPhoneCurfew().restricted) throw new Error(getPhoneCurfew().message)
            if (!navigator.onLine) throw new Error('当前离线，草稿已保留；联网后点击发送。')
            if (!pending.current) {
                try {
                    const parsed = NativeTerminalInputSchema.safeParse(JSON.parse(localStorage.getItem(storageKey) ?? 'null'))
                    if (parsed.success) pending.current = parsed.data
                } catch { /* Persist a new request below before dispatch. */ }
            }
            const attachmentIdentity = (items?: AttachmentMetadata[]) => JSON.stringify((items ?? []).map(item => [item.id, item.path]))
            if (pending.current?.text === text && attachmentIdentity(pending.current.attachments) === attachmentIdentity(attachments)) input = pending.current
            else {
                if (!binding || blockedReason) throw new Error(blockedReason ?? '原终端状态尚未确认，请稍后再试。')
                input = { requestId: crypto.randomUUID(), text, binding, ...(attachments?.length ? { attachments } : {}), ...(delivery ? { delivery } : {}) }
                localStorage.setItem(storageKey, JSON.stringify({ ...input, attachments: input.attachments?.map(({ previewUrl: _image, previewText: _text, ...item }) => item) }))
                pending.current = input
            }
            const result = await api.sendNativeTerminalInput(sessionId, input)
            if (!result.success) {
                pending.current = null
                localStorage.removeItem(storageKey)
                throw new Error(result.error)
            }
            if (result.receipt.status === 'rejected' || result.receipt.status === 'cancelled') {
                pending.current = null
                localStorage.removeItem(storageKey)
                throw new Error(result.receipt.note ?? '终端状态变化，消息未发送，草稿已保留。')
            }
            if (result.receipt.status === 'indeterminate') throw new Error(result.receipt.note ?? '发送结果待确认；再次点击只核对原请求，不会重复发送。')
            pending.current = null
            localStorage.removeItem(storageKey)
            setSettlement({ attemptId: input.requestId, status: 'success' })
            void client.invalidateQueries({ queryKey: ['native-terminal'] })
            return { attemptId: input.requestId }
        } catch (reason) {
            if (reason && typeof reason === 'object' && 'status' in reason && [400, 404, 409, 423].includes(Number(reason.status))) {
                pending.current = null
                try { localStorage.removeItem(storageKey) } catch { /* retain the in-memory draft */ }
            }
            if (input) setSettlement({ attemptId: input.requestId, status: 'error' })
            setError({ id: Date.now(), text, message: apiErrorMessage(reason, '发送失败，草稿已保留。'),
                // Native sends keep the live draft until acceptance. Restoring
                // it would treat the retained attachments as a replacement and
                // dismiss the error before the user can read it.
                scheduledAt: null, mutationStarted: Boolean(input), restoreSuppressed: true })
            void client.invalidateQueries({ queryKey: ['native-terminal'] })
            return false
        } finally { busy.current = false; setIsSending(false) }
    }, [api, sessionId, storageKey, client])
    return { send, isSending, error, clearError, settlement }
}
