import { useCallback, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { NativeTerminalControlSchema, type NativeTerminalControl } from '@hapi/protocol/apiTypes'
import type { ApiClient } from '@/api/client'
import { apiErrorMessage } from '@/lib/apiErrorMessage'

export function useNativeTerminalControl(api: ApiClient | null, sessionId?: string) {
    const client = useQueryClient()
    const busy = useRef(false)
    const pending = useRef<NativeTerminalControl | null>(null)
    const [isPending, setIsPending] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const perform = useCallback(async (action: NativeTerminalControl['action'], binding?: string, messageId?: string) => {
        if (busy.current || !api || !sessionId) return false
        busy.current = true; setIsPending(true); setError(null)
        const storageKey = `hapi.native-control.v1.${sessionId}`
        try {
            if (!navigator.onLine || !binding) throw new Error('原终端暂未连接，请恢复连接后再试。')
            if (!pending.current) {
                const saved = NativeTerminalControlSchema.safeParse(JSON.parse(localStorage.getItem(storageKey) ?? 'null'))
                if (saved.success) pending.current = saved.data
            }
            if (pending.current && (pending.current.action !== action || pending.current.messageId !== messageId)) {
                throw new Error('上次操作尚未确认，请再次点击原按钮核对结果。')
            }
            const request = pending.current ?? { requestId: crypto.randomUUID(), binding, action, ...(messageId ? { messageId } : {}) }
            localStorage.setItem(storageKey, JSON.stringify(request)); pending.current = request
            const result = await api.controlNativeTerminal(sessionId, request)
            if (!result.success) {
                pending.current = null
                localStorage.removeItem(storageKey)
                throw new Error(result.error)
            }
            if (result.status === 'indeterminate') throw new Error('操作结果待确认，再次点击会核对同一操作，不会重复打断或发送。')
            pending.current = null; localStorage.removeItem(storageKey)
            if (result.status === 'rejected') throw new Error('原终端状态已变化，操作未执行。')
            return true
        } catch (reason) {
            if (reason && typeof reason === 'object' && 'status' in reason && [400, 404, 409, 423].includes(Number(reason.status))) {
                pending.current = null; localStorage.removeItem(storageKey)
            }
            setError(apiErrorMessage(reason, '操作失败，请重试。'))
            return false
        } finally {
            busy.current = false; setIsPending(false)
            void client.invalidateQueries({ queryKey: ['native-terminal'] })
        }
    }, [api, sessionId, client])
    return { perform, isPending, error }
}
