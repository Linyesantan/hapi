import { useCallback, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { Session, SlashCommand } from '@/types/api'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { PRESERVE_SESSION_SIDEBAR_SCROLL } from '@/lib/sessionNavigation'
import { queryKeys } from '@/lib/query-keys'
import { isPhoneCli, PHONE_CLI_LABELS, resolvePhoneSlashCommand } from '@/lib/phoneSlashCommands'

export function usePhoneSlashCommandActions(props: {
    enabled?: boolean
    api: ApiClient
    session: Session
    commands?: readonly SlashCommand[]
    terminalSupported: boolean
    onFiles: () => void
    onTerminal: () => void
    onFork: () => Promise<void>
}) {
    const navigate = useNavigate()
    const queryClient = useQueryClient()
    const busy = useRef(false)
    const [dialog, setDialog] = useState<{ title: string; body: string; commands?: readonly SlashCommand[] } | null>(null)
    const [search, setSearch] = useState('')
    const agent = props.session.metadata?.flavor ?? ''
    const handle = useCallback(async (text: string, hasAttachments: boolean, scheduledAt?: number | null): Promise<{ handled: boolean; text?: string }> => {
        if (!props.enabled || !isPhoneCli(agent)) return { handled: false }
        const resolution = resolvePhoneSlashCommand(text, agent, props.commands ?? [], props.session.metadata?.capabilities?.concurrentClients)
        if (resolution.kind === 'passthrough') return { handled: false, text: resolution.text }
        setSearch('')
        if (resolution.kind === 'notice') {
            setDialog({ title: `/${resolution.name}`, body: resolution.message })
            return { handled: true }
        }
        if (hasAttachments || scheduledAt != null) {
            setDialog({ title: `/${resolution.name} 未执行`, body: '请单独执行网关命令，先移除附件或取消定时发送。' })
            return { handled: true }
        }
        if (resolution.action !== 'rename' && resolution.args) {
            setDialog({ title: `/${resolution.name} 用法`, body: `/${resolution.name} 不接受参数，请单独输入命令。` })
            return { handled: true }
        }
        if (busy.current) {
            setDialog({ title: '命令正在执行', body: '请等待上一个网关操作完成。' })
            return { handled: true }
        }
        busy.current = true
        try {
            switch (resolution.action) {
                case 'help':
                    setDialog({ title: '全部 / 命令', body: `当前 CLI：${PHONE_CLI_LABELS[agent]}。独有命令标注适用 CLI；标有“原终端”的命令需要在该 CLI 终端执行。`, commands: props.commands })
                    break
                case 'new':
                    await navigate({ to: '/sessions/new', search: { directory: props.session.metadata?.path }, ...PRESERVE_SESSION_SIDEBAR_SCROLL })
                    break
                case 'sessions':
                    await navigate({ to: '/sessions', ...PRESERVE_SESSION_SIDEBAR_SCROLL })
                    break
                case 'files':
                    props.onFiles()
                    break
                case 'terminal':
                    if (!props.session.active || !props.terminalSupported) throw new Error('当前会话没有可用的远程 shell。可在 Termux 用 hapi attach <会话名或 ID> 进入现有 tmux。')
                    props.onTerminal()
                    break
                case 'fork':
                    if (!props.session.active || props.session.thinking || props.session.metadata?.capabilities?.conversationHistory?.forkCurrent !== true) {
                        throw new Error('当前会话暂不能创建分支。请等待任务结束，并使用支持分支的活动会话。')
                    }
                    await props.onFork()
                    break
                case 'rename':
                    if (!resolution.args) throw new Error(`用法：/${resolution.name} <会话名称>`)
                    await props.api.renameSession(props.session.id, resolution.args)
                    await Promise.all([
                        queryClient.invalidateQueries({ queryKey: queryKeys.session(props.session.id) }),
                        queryClient.invalidateQueries({ queryKey: queryKeys.sessions }),
                    ])
                    setDialog({ title: '会话名称已更新', body: resolution.args })
                    break
                case 'skills': {
                    const result = await props.api.getSkills(props.session.id)
                    if (!result.success) throw new Error(result.error ?? '读取技能失败')
                    setDialog({ title: `${PHONE_CLI_LABELS[agent]} 技能`, body: result.skills?.length
                        ? result.skills.map(skill => `$${skill.name}${skill.description ? ` — ${skill.description}` : ''}`).join('\n\n')
                        : '当前 CLI 没有返回可用技能。' })
                    break
                }
            }
        } catch (reason) {
            setDialog({ title: `/${resolution.name} 未执行`, body: reason instanceof Error ? reason.message : '网关操作失败，请重试。' })
        } finally {
            busy.current = false
        }
        return { handled: true }
    }, [agent, navigate, queryClient, props.api, props.commands, props.enabled, props.onFiles, props.onFork, props.onTerminal, props.session, props.terminalSupported])

    const keyword = search.trim().toLowerCase()
    const visibleCommands = dialog?.commands?.filter(command => !keyword
        || `/${command.name} ${command.description ?? ''}`.toLowerCase().includes(keyword))
    return {
        handle,
        dialog: <Dialog open={dialog !== null} onOpenChange={open => { if (!open) setDialog(null) }}>
            <DialogContent className="flex max-h-[80dvh] flex-col">
                <DialogHeader>
                    <DialogTitle>{dialog?.title}</DialogTitle>
                    <DialogDescription className="whitespace-pre-wrap">{dialog?.body}</DialogDescription>
                </DialogHeader>
                {dialog?.commands ? <>
                    <input aria-label="搜索命令说明" placeholder="搜索命令或 CLI" value={search} onChange={event => setSearch(event.target.value)}
                        className="rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-sm" />
                    <div className="min-h-0 overflow-y-auto">
                        {visibleCommands?.map(command => <div key={command.name} className="border-b border-[var(--app-border)] py-2">
                            <code className="text-sm font-medium">/{command.name}</code>
                            <p className="text-xs text-[var(--app-hint)]">{command.description}</p>
                        </div>)}
                    </div>
                </> : null}
            </DialogContent>
        </Dialog>,
    }
}
