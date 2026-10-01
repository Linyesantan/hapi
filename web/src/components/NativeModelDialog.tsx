import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { NativeModelActionSchema, type NativeModelAction, type NativeModelMenu, type NativeCodexTerminalState, type NativeTerminalRequest } from '@hapi/protocol/apiTypes'
import type { ApiClient } from '@/api/client'
import { queryKeys } from '@/lib/query-keys'
import { apiErrorMessage } from '@/lib/apiErrorMessage'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import '@xterm/xterm/css/xterm.css'

function MenuScreen({ menu }: { menu: NativeModelMenu }) {
    const container = useRef<HTMLDivElement>(null)
    useEffect(() => {
        let disposed = false
        let terminal: import('@xterm/xterm').Terminal | undefined
        void import('@xterm/xterm').then(({ Terminal }) => {
            if (disposed || !container.current) return
            terminal = new Terminal({ cols: menu.columns, rows: Math.max(3, menu.ansi.split('\n').length),
                disableStdin: true, convertEol: true, scrollback: 0, fontSize: 12,
                theme: { background: '#101218', foreground: '#e5e7eb' } })
            terminal.open(container.current)
            terminal.write(`\x1b[?25l${menu.ansi}`)
        })
        return () => { disposed = true; terminal?.dispose() }
    }, [menu.ansi, menu.columns])
    return <div className="max-h-[55dvh] overflow-auto rounded-lg bg-[#101218] p-2" data-native-model-menu>
        <div ref={container} aria-hidden="true" />
        <pre className="sr-only">{menu.text}</pre>
    </div>
}

export function NativeModelDialog(props: {
    api: ApiClient; sessionId: string; request: NativeTerminalRequest; machineId?: string | null
    state?: NativeCodexTerminalState; stale: boolean; open: boolean; onOpenChange: (open: boolean) => void
}) {
    const client = useQueryClient()
    const opened = useRef(false)
    const busyRef = useRef(false)
    const pendingRef = useRef<NativeModelAction | null>(null)
    const [busy, setBusy] = useState(false)
    const [uncertain, setUncertain] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const storageKey = `hapi.native-model.v1.${props.sessionId}`
    const queryKey = queryKeys.nativeTerminal(props.request.agent, props.request.sessionId, props.machineId)
    const menu = props.state?.modelMenu
    const unavailable = props.stale

    const perform = useCallback(async (action: NativeModelAction['action'], retry = false) => {
        if (busyRef.current) return
        busyRef.current = true; setBusy(true); setError(null)
        try {
            if (props.stale) throw new Error('原终端暂未连接，恢复连接后再选择模型。')
            if (!pendingRef.current) {
                const saved = NativeModelActionSchema.safeParse(JSON.parse(localStorage.getItem(storageKey) ?? 'null'))
                if (saved.success) pendingRef.current = saved.data
            }
            if (pendingRef.current && !retry) {
                setUncertain(true)
                throw new Error('有一项操作尚未核对，请先核对上次操作或检查当前菜单。')
            }
            const binding = props.state?.input?.binding
            if (!binding) throw new Error('原终端尚未确认，请稍后重新打开。')
            const request = retry && pendingRef.current ? pendingRef.current : {
                requestId: crypto.randomUUID(), binding, action,
                ...(action === 'open' ? {} : { fingerprint: props.state?.modelMenu?.fingerprint })
            }
            const parsed = NativeModelActionSchema.parse(request)
            localStorage.setItem(storageKey, JSON.stringify(parsed))
            pendingRef.current = parsed
            const result = await props.api.controlNativeModelMenu(props.sessionId, parsed)
            if (!result.success) throw new Error(result.error)
            client.setQueryData<NativeCodexTerminalState>(queryKeys.nativeTerminal(props.request.agent, props.request.sessionId, props.machineId), old => ({
                ...result.state, submissions: old?.submissions
            }))
            if (result.status === 'indeterminate') {
                setUncertain(true)
                throw new Error('操作结果待确认，已刷新原菜单；请核对后继续，系统不会自动重复操作。')
            }
            pendingRef.current = null; localStorage.removeItem(storageKey); setUncertain(false)
            if (result.status === 'rejected') throw new Error('原终端状态变化，这次操作没有执行。')
            if (!result.state.modelMenu && result.state.input?.available && parsed.action !== 'open') props.onOpenChange(false)
            else if (!result.state.modelMenu) setError('正在等待原终端显示模型菜单；若终端有其他提示，可关闭窗口查看原终端画面。')
        } catch (reason) {
            const status = reason && typeof reason === 'object' && 'status' in reason ? Number(reason.status) : undefined
            if (status && [400, 404, 409, 423].includes(status)) {
                pendingRef.current = null; localStorage.removeItem(storageKey); setUncertain(false)
            } else if (pendingRef.current) setUncertain(true)
            setError(apiErrorMessage(reason, '暂时无法操作模型菜单。'))
        } finally {
            busyRef.current = false; setBusy(false)
            void client.invalidateQueries({ queryKey: ['native-terminal'] })
        }
    }, [client, props.api, props.sessionId, props.request.agent, props.request.sessionId, props.machineId,
        props.stale, props.state?.input?.binding, props.state?.modelMenu?.fingerprint, props.onOpenChange, storageKey])

    useEffect(() => {
        if (!props.open) { opened.current = false; return }
        if (opened.current || !props.state?.input?.binding || unavailable) return
        opened.current = true
        void perform('open')
    }, [props.open, props.state?.input?.binding, unavailable, perform])

    const buttonClass = 'min-h-11 rounded-lg border border-[var(--app-divider)] px-3 text-sm disabled:opacity-40'
    return <Dialog open={props.open} onOpenChange={props.onOpenChange}>
        <DialogContent className="max-w-2xl">
            <DialogHeader>
                <DialogTitle>{menu?.kind === 'effort' ? '推理强度选择' : '模型选择'}</DialogTitle>
                <DialogDescription>{props.request.agent === 'codex' ? 'Codex' : 'OpenCode'} 原会话的可用选项；上下选择后确认。</DialogDescription>
            </DialogHeader>
            <div className="mt-3 space-y-3">
                {menu ? <MenuScreen menu={menu} /> : <p className="text-sm text-[var(--app-hint)]">{busy ? '正在打开原终端模型菜单…' : props.state?.input?.reason ?? '正在连接原终端…'}</p>}
                {error ? <p role="alert" className="text-sm text-[var(--app-warning)]">{error}</p> : null}
                {uncertain ? <div className="flex flex-wrap gap-2">
                    <button type="button" className={buttonClass} disabled={busy || unavailable} onClick={() => void perform('open', true)}>核对上次操作</button>
                    <button type="button" className={buttonClass} disabled={busy || unavailable} onClick={() => {
                        pendingRef.current = null; localStorage.removeItem(storageKey); setUncertain(false); setError(null)
                    }}>已核对，继续选择</button>
                </div> : <div className="grid grid-cols-4 gap-2">
                    <button type="button" className={buttonClass} disabled={busy || unavailable || !menu} onClick={() => void perform('up')}>↑ 上一个</button>
                    <button type="button" className={buttonClass} disabled={busy || unavailable || !menu} onClick={() => void perform('down')}>↓ 下一个</button>
                    <button type="button" className={buttonClass} disabled={busy || unavailable || !menu} onClick={() => void perform('confirm')}>确认</button>
                    <button type="button" className={buttonClass} disabled={busy || unavailable || !menu} onClick={() => void perform('cancel')}>返回</button>
                </div>}
                <button type="button" className="text-xs text-[var(--app-link)]" disabled={busy} onClick={() => void client.invalidateQueries({ queryKey })}>刷新菜单</button>
            </div>
        </DialogContent>
    </Dialog>
}
