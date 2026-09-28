import type { SlashCommand } from './apiTypes'

export const BUILTIN_SLASH_COMMANDS = {
    claude: [
        { name: 'clear', description: 'Clear conversation history and free up context', source: 'builtin' },
        { name: 'compact', description: 'Clear conversation history but keep a summary in context', source: 'builtin' },
        { name: 'context', description: 'Visualize current context usage as a colored grid', source: 'builtin' },
        { name: 'cost', description: 'Show the total cost and duration of the current session', source: 'builtin' },
        { name: 'doctor', description: 'Diagnose and verify your Claude Code installation and settings', source: 'builtin' },
        { name: 'plan', description: 'View or open the current session plan', source: 'builtin' },
        { name: 'stats', description: 'Show your Claude Code usage statistics and activity', source: 'builtin' },
        { name: 'status', description: 'Show Claude Code status including version, model, account, and API connectivity', source: 'builtin' },
    ],
    codex: [
        { name: 'agent', description: '旧版会话的协作开关：on / off / status；共享会话请在原终端切换子线程', source: 'builtin' },
        { name: 'clear', description: '清空当前对话上下文', source: 'builtin' },
        { name: 'compact', description: '压缩当前对话上下文', source: 'builtin' },
        { name: 'goal', description: '查看或设置持续目标；pause / resume / clear 管理目标', source: 'builtin' },
        { name: 'help', description: '查看命令帮助', source: 'builtin' },
        { name: 'plan', description: '进入计划模式，可附带任务；/plan off 退出', source: 'builtin' },
        { name: 'default', description: '退出计划模式，恢复默认模式', source: 'builtin' },
        { name: 'execute', description: '恢复默认执行模式，等同 /default', source: 'builtin' },
        { name: 'status', description: '查看当前模型、权限和会话设置', source: 'builtin' },
        { name: 'model', description: '查看或设置模型：/model <模型名>', source: 'builtin' },
        { name: 'reasoning', description: '查看或设置推理强度：/reasoning <级别|default>', source: 'builtin' },
        { name: 'effort', description: '查看或设置推理强度，等同 /reasoning', source: 'builtin' },
        { name: 'personality', description: '查看或设置回复风格：friendly / pragmatic / none', source: 'builtin' },
        { name: 'fast', description: '快速服务档位：/fast on / off / status，需模型和账号支持', source: 'builtin' },
        { name: 'permissions', description: '查看或设置权限：default / read-only / safe-yolo / yolo', source: 'builtin' },
        { name: 'permission', description: '查看或设置权限，等同 /permissions', source: 'builtin' },
    ],
    gemini: [
        { name: 'about', description: 'Show version info', source: 'builtin' },
        { name: 'clear', description: 'Clear the screen and conversation history', source: 'builtin' },
        { name: 'compress', description: 'Compress the context by replacing it with a summary', source: 'builtin' },
        { name: 'stats', description: 'Check session stats', source: 'builtin' },
    ],
    grok: [
        { name: 'compact', description: 'Compress conversation history to save context', source: 'builtin' },
        { name: 'context', description: 'Show context window usage and session stats', source: 'builtin' },
        { name: 'session-info', description: 'Show Grok session model, turns, and context usage', source: 'builtin' },
        { name: 'goal', description: 'Set, manage, or inspect an autonomous goal', source: 'builtin' },
        { name: 'always-approve', description: 'Toggle automatic tool approval', source: 'builtin' },
        { name: 'auto', description: 'Let Grok classify safe tool calls for automatic approval', source: 'builtin' },
    ],
    opencode: [
        { name: 'help', description: '查看命令帮助', source: 'builtin' },
        { name: 'status', description: '查看当前模型、权限和会话设置', source: 'builtin' },
        { name: 'plan', description: '进入计划模式，可附带任务；/plan off 退出', source: 'builtin' },
        { name: 'default', description: '退出计划模式，恢复默认模式', source: 'builtin' },
        { name: 'init', description: '生成或更新项目的 AGENTS.md，可附带要求', source: 'builtin' },
        { name: 'compact', description: '压缩当前对话上下文', source: 'builtin' },
        { name: 'clear', description: '归档当前会话并打开一个新的 OpenCode 会话', source: 'builtin' },
        { name: 'model', description: '查看或设置模型：/model <模型名>', source: 'builtin' },
        { name: 'reasoning', description: '查看或设置推理强度：/reasoning <级别|default>', source: 'builtin' },
        { name: 'effort', description: '查看或设置推理强度，等同 /reasoning', source: 'builtin' },
        { name: 'permissions', description: '查看或设置权限：default / plan / yolo', source: 'builtin' },
        { name: 'permission', description: '查看或设置权限，等同 /permissions', source: 'builtin' },
    ],
    cursor: [
        { name: 'compress', description: 'Compress conversation context to free window space (pass-through to Cursor agent)', source: 'builtin' },
    ],
    copilot: [
        { name: 'help', description: 'Show supported Copilot slash commands', source: 'builtin' },
        { name: 'status', description: 'Show current Copilot session config', source: 'builtin' },
        { name: 'plan', description: 'Start plan mode for structured implementation planning', source: 'builtin' },
        { name: 'autopilot', description: 'Start autopilot mode for autonomous multi-step work', source: 'builtin' },
        { name: 'fleet', description: 'Run parallel subagents for a task (combine with Interactive/Plan/Autopilot)', source: 'builtin' },
        { name: 'tasks', description: 'List or manage fleet tasks', source: 'builtin' },
        { name: 'subagents', description: 'Manage Copilot subagents', source: 'builtin' },
        { name: 'agents', description: 'Alias for /subagents', source: 'builtin' },
        { name: 'delegate', description: 'Delegate work to a subagent', source: 'builtin' },
        { name: 'agent', description: 'Select or configure a custom agent', source: 'builtin' },
        { name: 'rubber-duck', description: 'Consult the rubber-duck agent for a second opinion on plans, code, and tests', source: 'builtin' },
        { name: 'security-review', description: 'Run a focused security review of active local code changes', source: 'builtin' },
        { name: 'research', description: 'Run a deep research investigation across the codebase and web', source: 'builtin' },
        { name: 'review', description: 'Run the code-review agent on current changes', source: 'builtin' },
        { name: 'skills', description: 'List, inspect, add, or remove Copilot skills', source: 'builtin' },
        { name: 'context', description: 'Show current context usage', source: 'builtin' },
        { name: 'model', description: 'Show or switch the active model', source: 'builtin' },
        { name: 'permissions', description: 'Show or set permission mode', source: 'builtin' },
        { name: 'permission', description: 'Alias for /permissions', source: 'builtin' },
        { name: 'usage', description: 'Show session usage metrics', source: 'builtin' },
    ],
    kimi: [],
    // Pi runs `pi --mode rpc` over stdio; only commands HAPI can translate
    // to Pi RPC calls are listed. Terminal-only Pi builtins (e.g. /tree,
    // /export, /reload) are intercepted with an explicit "not supported"
    // message instead of being passed to the model as plain text.
    pi: [
        { name: 'help', description: '查看命令帮助', source: 'builtin' },
        { name: 'compact', description: '压缩当前对话上下文，可附带压缩要求', source: 'builtin' },
        { name: 'session', description: '查看会话 token、费用和上下文用量', source: 'builtin' },
        { name: 'model', description: '查看或设置模型：/model <模型名>', source: 'builtin' },
    ],
} as const satisfies Record<string, readonly SlashCommand[]>

export function getBuiltinSlashCommands(agent: string): SlashCommand[] {
    const commands = BUILTIN_SLASH_COMMANDS[agent as keyof typeof BUILTIN_SLASH_COMMANDS]
        ?? BUILTIN_SLASH_COMMANDS.claude
    return commands.map((command) => ({ ...command }))
}

export function mergeSlashCommands(commands: readonly SlashCommand[]): SlashCommand[] {
    const commandMap = new Map<string, SlashCommand>()
    for (const command of commands) {
        const key = command.name.toLowerCase()
        if (commandMap.has(key)) {
            commandMap.delete(key)
        }
        commandMap.set(key, command)
    }
    return Array.from(commandMap.values())
}
