import { getBuiltinSlashCommands } from '@hapi/protocol/slashCommands'
import type { SlashCommand } from '@/types/api'

export const PHONE_CLIS = ['codex', 'opencode', 'pi'] as const
export type PhoneCli = typeof PHONE_CLIS[number]
export const PHONE_CLI_LABELS: Record<PhoneCli, string> = { codex: 'Codex', opencode: 'OpenCode', pi: 'Pi' }

// 原终端的命令也保留在统一目录中，明确标注使用位置。它们不能作为普通提示词发送。
// 来源：Codex /cli/slash-commands、OpenCode tui.mdx、Pi 安装包 core/slash-commands.js。
const terminalCommands: Record<PhoneCli, Record<string, string>> = {
    codex: {
        agent: '切换子代理线程', subagents: '切换子代理线程',
        apps: '浏览应用连接器', plugins: '浏览和管理插件', hooks: '查看和管理生命周期钩子',
        ide: '附加 IDE 中的文件和选区', keymap: '配置终端快捷键', vim: '切换 Vim 输入模式',
        'setup-default-sandbox': '设置 Windows 沙箱', 'sandbox-add-read-dir': '添加 Windows 沙箱可读目录',
        archive: '归档当前原生会话并退出', delete: '删除当前原生会话及其后代',
        copy: '复制最近的完整回复；网页可使用消息的复制按钮',
        exit: '退出原终端 CLI', quit: '退出原终端 CLI',
        experimental: '配置实验性功能', approve: '重试自动审批拒绝的操作',
        memories: '配置记忆生成和使用', import: '导入其他工具的设置或记录',
        feedback: '向 Codex 维护者提交诊断反馈', init: '生成项目 AGENTS.md',
        logout: '退出 Codex 账号', mcp: '查看 MCP 服务和工具',
        mention: '附加文件；网页可输入 @ 搜索文件',
        ps: '查看后台终端及输出', stop: '停止当前 Codex 的后台终端',
        app: '转到桌面应用继续会话', side: '打开临时旁支对话', btw: '打开临时旁支对话',
        raw: '切换终端原始输出模式', review: '审查当前代码改动', usage: '查看账号用量和限额',
        'debug-config': '查看配置层及策略诊断', statusline: '配置终端状态栏',
        title: '配置终端窗口标题', theme: '选择终端代码配色', pets: '选择终端宠物', pet: '选择终端宠物',
    },
    opencode: {
        connect: '添加或登录模型提供商', details: '切换终端工具详情显示',
        editor: '调用电脑上的外部编辑器', exit: '退出原终端 CLI', quit: '退出原终端 CLI', q: '退出原终端 CLI',
        export: '导出原生会话并在电脑编辑器打开', models: '选择模型；网页也可使用输入框的模型按钮',
        redo: '重做原生撤销操作', undo: '撤销消息及对应文件改动',
        share: '创建原生会话分享链接', unshare: '取消原生会话分享',
        themes: '选择终端主题', thinking: '切换终端推理内容显示',
    },
    pi: {
        settings: '打开 Pi 终端设置', 'scoped-models': '配置终端快捷切换的模型范围',
        export: '导出原生会话为 HTML 或 JSONL', import: '导入并继续 JSONL 会话',
        share: '把原生会话分享到 GitHub gist', copy: '复制最近回复；网页可使用消息的复制按钮',
        changelog: '查看 Pi 更新记录', hotkeys: '查看终端快捷键',
        clone: '复制当前原生会话位置', tree: '浏览原生会话分支树',
        login: '配置模型提供商认证', logout: '移除模型提供商认证',
        reload: '重新加载快捷键、扩展、技能、提示词和主题', quit: '退出原终端 CLI',
    },
}

type GatewayAction = 'help' | 'new' | 'sessions' | 'files' | 'terminal' | 'fork' | 'rename' | 'skills'
const gatewayCommands: { name: string; description: string; action: GatewayAction; agents?: PhoneCli[] }[] = [
    { name: 'help', description: '查看完整命令说明，支持搜索', action: 'help' },
    { name: 'commands', description: '查看完整命令说明，等同 /help', action: 'help' },
    { name: 'new', description: '选择 CLI 并创建独立 tmux 会话', action: 'new' },
    { name: 'sessions', description: '打开网关会话列表，查看或切换已有会话', action: 'sessions' },
    { name: 'resume', description: '从网关会话列表选择要继续或查看的记录', action: 'sessions' },
    { name: 'continue', description: '打开会话列表，等同 /sessions', action: 'sessions', agents: ['opencode'] },
    { name: 'diff', description: '打开当前会话的文件改动', action: 'files' },
    { name: 'files', description: '打开文件和改动浏览器', action: 'files' },
    { name: 'terminal', description: '打开当前会话的远程 shell', action: 'terminal' },
    { name: 'fork', description: '从当前对话创建分支；需要会话支持且处于空闲状态', action: 'fork' },
    { name: 'rename', description: '重命名网关中的会话：/rename <名称>', action: 'rename' },
    { name: 'name', description: '重命名会话：/name <名称>', action: 'rename', agents: ['pi'] },
    { name: 'skills', description: '列出当前 CLI 可用的技能', action: 'skills' },
]

export function isPhoneCli(value: string): value is PhoneCli {
    return (PHONE_CLIS as readonly string[]).includes(value)
}

export function getPhoneSlashCommands(agent: string, discovered: readonly SlashCommand[] = [], sharedCodex = false): SlashCommand[] {
    const catalog = new Map<string, Map<PhoneCli, { description: string; terminal: boolean }>>()
    const add = (name: string, cli: PhoneCli, description: string, terminal = false) => {
        const entry = catalog.get(name) ?? new Map()
        entry.set(cli, { description, terminal })
        catalog.set(name, entry)
    }
    for (const cli of PHONE_CLIS) {
        for (const [name, description] of Object.entries(terminalCommands[cli])) add(name, cli, description, true)
        for (const command of getBuiltinSlashCommands(cli)) {
            if (cli === 'codex' && command.name === 'agent' && sharedCodex) continue
            add(command.name, cli, command.description ?? command.name)
        }
    }
    add('summarize', 'opencode', '压缩当前对话上下文，等同 /compact')
    // 新版本 CLI 返回的额外内置命令不能被固定目录丢掉。
    if (isPhoneCli(agent)) {
        for (const command of discovered) {
            if (command.source === 'builtin' && !catalog.get(command.name)?.has(agent)) {
                add(command.name, agent, command.description ?? command.name)
            }
        }
    }
    const commands = new Map<string, SlashCommand>()
    for (const [name, entry] of catalog) {
        const grouped = new Map<string, PhoneCli[]>()
        for (const [cli, detail] of entry) {
            const key = `${detail.terminal ? '原终端 · ' : ''}${detail.description}`
            grouped.set(key, [...(grouped.get(key) ?? []), cli])
        }
        commands.set(name, {
            name, source: 'builtin',
            description: [...grouped].map(([description, clis]) => `【${clis.map(cli => PHONE_CLI_LABELS[cli]).join(' / ')}】${description}`).join('；'),
        })
    }
    for (const command of gatewayCommands) {
        const label = command.agents?.map(cli => PHONE_CLI_LABELS[cli]).join(' / ') ?? '网关 · 三种 CLI 通用'
        commands.set(command.name, { name: command.name, source: 'builtin', description: `【${label}】${command.description}` })
    }
    for (const command of discovered) {
        if (command.source === 'builtin') continue
        const label = isPhoneCli(agent) ? PHONE_CLI_LABELS[agent] : agent
        const source = command.name.startsWith('skill:') ? '技能' : { user: '用户命令', project: '项目命令', plugin: '扩展命令' }[command.source]
        commands.set(command.name.toLowerCase(), { ...command, description: `【${label} · ${source}】${command.description ?? command.name}` })
    }
    // 当前可执行项排前面，原终端项仍完整保留并可搜索。
    const priority = (command: SlashCommand) => {
        if (command.source !== 'builtin') return 1
        if (gatewayCommands.some(item => item.name === command.name && (!item.agents || item.agents.includes(agent as PhoneCli)))) return 0
        if (isPhoneCli(agent) && getBuiltinSlashCommands(agent).some(item => item.name === command.name)) return 1
        return 2
    }
    return [...commands.values()].sort((a, b) => priority(a) - priority(b) || a.name.localeCompare(b.name))
}

export type PhoneSlashResolution =
    | { kind: 'passthrough'; text?: string }
    | { kind: 'gateway'; action: GatewayAction; name: string; args: string }
    | { kind: 'notice'; name: string; message: string }

export function resolvePhoneSlashCommand(text: string, agent: string, available: readonly SlashCommand[], sharedCodex = false): PhoneSlashResolution {
    const match = /^\s*\/([a-z0-9:_-]+)(?:\s+([\s\S]*))?$/i.exec(text)
    if (!match || !isPhoneCli(agent)) return { kind: 'passthrough' }
    const name = match[1].toLowerCase()
    const args = match[2]?.trim() ?? ''
    // 当前 CLI 的项目 / 用户 / 扩展命令优先，包括与内置命令同名的覆盖。
    if (available.some(command => command.name.toLowerCase() === name && command.source !== 'builtin')) return { kind: 'passthrough' }
    const gateway = gatewayCommands.find(command => command.name === name)
    if (gateway && (!gateway.agents || gateway.agents.includes(agent))) return { kind: 'gateway', action: gateway.action, name, args }
    if (name === 'summarize' && agent === 'opencode') return { kind: 'passthrough', text: args ? `/compact ${args}` : '/compact' }
    if (!(sharedCodex && agent === 'codex' && name === 'agent')
        && getBuiltinSlashCommands(agent).some(command => command.name === name)) return { kind: 'passthrough' }
    if (terminalCommands[agent][name]) {
        return { kind: 'notice', name, message: `${PHONE_CLI_LABELS[agent]} 的 /${name} 需要在原 CLI 终端执行。${terminalCommands[agent][name]}。网关不会把这条命令当作普通问题发送。` }
    }
    const supportedBy = PHONE_CLIS.filter(cli => terminalCommands[cli][name]
        || getBuiltinSlashCommands(cli).some(command => command.name === name)
        || gateway?.agents?.includes(cli) || (name === 'summarize' && cli === 'opencode'))
    if (supportedBy.length > 0) return { kind: 'notice', name, message: `/${name} 适用于 ${supportedBy.map(cli => PHONE_CLI_LABELS[cli]).join(' / ')}；当前会话是 ${PHONE_CLI_LABELS[agent]}。请从会话列表切换到相应 CLI。` }
    return { kind: 'passthrough' }
}
