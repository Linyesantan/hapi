import { useRef, useState, type FormEvent } from 'react'
import type { PhoneGatewayAgent, PhoneGatewayCreateRequest } from '@hapi/protocol/apiTypes'
import { ApiError, type ApiClient } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/Spinner'
import { DshWebLink } from '@/components/NewSession/DshWebLink'

const agents: { id: PhoneGatewayAgent | 'dsh'; label: string }[] = [
    { id: 'opencode', label: 'OpenCode' },
    { id: 'codex', label: 'Codex' },
    { id: 'pi', label: 'Pi' },
    { id: 'dsh', label: 'DSH' }
]

export function PhoneGatewayNewSession(props: {
    api: ApiClient
    initialDirectory?: string
    onCancel: () => void
    onSuccess: (sessionId: string) => void
}) {
    const [agent, setAgent] = useState<PhoneGatewayAgent | 'dsh'>('opencode')
    const [directory, setDirectory] = useState(props.initialDirectory ?? '')
    const [pending, setPending] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const inFlight = useRef(false)
    const lastRequest = useRef<PhoneGatewayCreateRequest | null>(null)

    const create = async (event: FormEvent) => {
        event.preventDefault()
        if (inFlight.current) return
        if (agent === 'dsh') {
            inFlight.current = true
            setPending(true)
            setError(null)
            try {
                const status = await props.api.openDshWeb()
                if (status.running && status.url) {
                    window.open(status.url, '_blank')
                } else setError('DSH Web 未能启动，请稍后重试。')
            } catch {
                setError('DSH Web 启动请求失败，请重试。')
            } finally {
                inFlight.current = false
                setPending(false)
            }
            return
        }
        inFlight.current = true
        setPending(true)
        setError(null)
        const path = directory.trim() || undefined
        // 响应丢失时继续使用同一请求；换程序或目录才是另一份新建任务。
        if (lastRequest.current?.agent !== agent || lastRequest.current?.directory !== path) {
            lastRequest.current = { agent, directory: path, requestId: crypto.randomUUID() }
        }
        try {
            const session = await props.api.createPhoneGatewaySession(lastRequest.current)
            props.onSuccess(session.session_id)
        } catch (reason) {
            if (reason instanceof ApiError && reason.code === 'gateway_session_ended') {
                lastRequest.current = null
                setError('上次启动的程序已结束。重新点击「创建并启动」会创建新会话。')
            } else setError(reason instanceof ApiError
                ? reason.code ?? '网关连接失败，请重试'
                : reason instanceof TypeError || (reason instanceof DOMException && reason.name === 'TimeoutError')
                    ? '连接中断，暂未确认启动结果；重试会复用同一请求。'
                    : reason instanceof Error ? reason.message : '创建失败，请重试')
        } finally {
            inFlight.current = false
            setPending(false)
        }
    }

    return (
        <form onSubmit={create} className="mx-auto flex w-full max-w-content flex-col gap-5 p-4">
            <p className="text-sm text-[var(--app-hint)]">选择程序并启动新会话，所有会话都可从首页查看和切换。</p>
            <DshWebLink api={props.api} />
            <fieldset disabled={pending} className="flex flex-col gap-2">
                <legend className="mb-2 text-sm font-medium">选择 CLI</legend>
                <div className="grid grid-cols-4 gap-2">
                    {agents.map(item => (
                        <label key={item.id} className={`flex cursor-pointer items-center justify-center gap-2 rounded-lg border px-3 py-4 ${agent === item.id ? 'border-[var(--app-button)] bg-[var(--app-secondary-bg)]' : 'border-[var(--app-border)]'}`}>
                            <input type="radio" name="gateway-agent" value={item.id} checked={agent === item.id}
                                onChange={() => setAgent(item.id)} />
                            <span className="font-medium">{item.label}</span>
                        </label>
                    ))}
                </div>
            </fieldset>
            <label className="flex flex-col gap-2 text-sm font-medium">
                电脑上的工作目录
                <input value={directory} onChange={event => setDirectory(event.target.value)} disabled={pending}
                    placeholder="留空使用电脑主目录" autoCapitalize="none" autoCorrect="off" spellCheck={false}
                    className="rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-3 text-base font-normal" />
            </label>
            {error ? <p role="alert" className="text-sm text-red-600">{error}</p> : null}
            <div className="flex justify-end gap-2">
                <Button type="button" variant="secondary" onClick={props.onCancel} disabled={pending}>取消</Button>
                <Button type="submit" disabled={pending} aria-busy={pending} className="gap-2">
                    {agent === 'dsh'
                        ? (pending ? <><Spinner size="sm" label={null} />正在打开…</> : '打开 DSH Web')
                        : (pending ? <><Spinner size="sm" label={null} />正在启动…</> : '创建并启动')}
                </Button>
            </div>
        </form>
    )
}
