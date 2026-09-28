import type { SlashCommand } from './apiTypes'
import { AGENT_FLAVORS, type AgentFlavor } from './modes'

// Every AgentFlavor must appear here, including the ones with no commands.
// Typed against AgentFlavor so that adding a flavor to modes.ts without
// deciding its catalog is a compile error rather than a silent fallthrough to
// the claude list below.
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
        { name: 'compact', description: '压缩当前对话上下文（仅远程 OpenCode 会话可用）', source: 'builtin' },
        { name: 'clear', description: '归档当前会话并打开一个新的 OpenCode 会话（仅由 runner 启动的会话可用）', source: 'builtin' },
        { name: 'model', description: '查看或设置模型：/model <模型名>', source: 'builtin' },
        { name: 'reasoning', description: '查看或设置推理强度：/reasoning <级别|default>', source: 'builtin' },
        { name: 'effort', description: '查看或设置推理强度，等同 /reasoning', source: 'builtin' },
        { name: 'permissions', description: '查看或设置权限：default / plan / yolo', source: 'builtin' },
        { name: 'permission', description: '查看或设置权限，等同 /permissions', source: 'builtin' },
    ],
    // Every command in CURSOR_PASS_THROUGH_COMMANDS_WITH_ARGS
    // (cli/src/cursor/cursorSpecialCommands.ts) is listed here. Only `compress`
    // used to be, so the other twelve were reachable but undiscoverable. These
    // are passed through to the Cursor agent as ACP prompt text; the
    // interactive TUI / IDE-only commands are deliberately absent.
    cursor: [
        { name: 'compress', description: 'Compress conversation context to free window space (pass-through to Cursor agent)', source: 'builtin' },
        { name: 'compact', description: 'Compress conversation context, alias of /compress (pass-through)', source: 'builtin' },
        { name: 'summarize', description: 'Summarize the conversation (pass-through)', source: 'builtin' },
        { name: 'model', description: 'Change the model, optionally /model <name> (pass-through)', source: 'builtin' },
        { name: 'multitask', description: 'Run async subagents via multitask (pass-through)', source: 'builtin' },
        { name: 'best-of-n', description: 'Run a best-of-N comparison (pass-through)', source: 'builtin' },
        { name: 'worktree', description: 'Create a Cursor worktree (pass-through)', source: 'builtin' },
        { name: 'apply-worktree', description: 'Apply the current Cursor worktree (pass-through)', source: 'builtin' },
        { name: 'delete-worktree', description: 'Delete the current Cursor worktree (pass-through)', source: 'builtin' },
        { name: 'add-dir', description: 'Add a workspace directory, /add-dir <path> (pass-through)', source: 'builtin' },
        { name: 'context', description: 'Show a context breakdown (pass-through)', source: 'builtin' },
        { name: 'fork', description: 'Fork the conversation (pass-through)', source: 'builtin' },
        { name: 'auto-review', description: 'Toggle auto-review mode (pass-through)', source: 'builtin' },
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
        { name: 'interactive', description: 'Enter interactive mode, the counterpart of /plan and /autopilot', source: 'builtin' },
        { name: 'default', description: 'Alias for /interactive', source: 'builtin' },
        { name: 'mode', description: 'Show or set the agent mode: /mode interactive|plan|autopilot', source: 'builtin' },
        { name: 'usage', description: 'Show session usage metrics', source: 'builtin' },
    ],
    kimi: [],
    // agy (Antigravity) runs headless via `agy -p <prompt>`: HAPI never starts
    // its TUI, so none of the native slash commands are reachable, and no
    // resolver in cli/src/agy/ intercepts any. Unhandled commands are sent to
    // the model verbatim, so listing commands here would advertise features
    // that cannot work. Same reasoning as kimi.
    agy: [],
    // dsh (DeepSeek Harness) talks ACP over stdio; session/prompt carries plain
    // text only and ACP has no slash-command channel. No resolver in
    // cli/src/dsh/, and neither user- nor project-level custom command
    // directories are registered for it.
    dsh: [],
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
} as const satisfies Record<AgentFlavor, readonly SlashCommand[]>

export function getBuiltinSlashCommands(agent: string): SlashCommand[] {
    // Unknown flavors get an empty list rather than the claude catalog. The old
    // `?? BUILTIN_SLASH_COMMANDS.claude` fallback assumed "unknown agent behaves
    // like claude", which is how agy and dsh users were shown /clear, /cost and
    // /doctor - commands no resolver implements for them, so they were sent to
    // the model as literal text. An honest empty menu is the safer default.
    const commands = AGENT_FLAVORS.includes(agent as AgentFlavor)
        ? BUILTIN_SLASH_COMMANDS[agent as keyof typeof BUILTIN_SLASH_COMMANDS]
        : []
    return commands.map((command) => ({ ...command }))
}

/** A message that is exactly one `/command` token plus optional arguments. */
export type ParsedSlashCommand = {
    /** Command name, lowercased. May contain `:` for nested/plugin commands. */
    name: string
    /** Everything after the command name, trimmed. Empty string when absent. */
    rest: string
}

/**
 * Parse a message that consists of a single leading `/command` token.
 *
 * The entire message must be the command, optionally followed by whitespace and
 * arguments, so a file path such as `/compact.md` does not parse as `/compact`
 * with `rest === '.md'`. Names may contain `:`, `-` and `_`; a namespace
 * separator is part of the name, not an argument.
 *
 * This is the single source for the opencode / codex / copilot / phone-gateway
 * resolvers, which each used to inline the same pattern. pi keeps its own
 * `parseLeadingSlashName` because it needs a different contract: the name
 * alone, from the front of a longer message.
 */
export function parseSlashCommand(text: string): ParsedSlashCommand | null {
    const match = /^\s*\/([a-z0-9:_-]+)(?:\s+([\s\S]*))?$/i.exec(text)
    if (!match) return null
    const name = match[1]
    if (!name) return null
    return { name: name.toLowerCase(), rest: match[2]?.trim() ?? '' }
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

/**
 * Commands that stay in the catalog because they are valid for some runtimes,
 * but cannot be executed by a shared Codex session.
 *
 * A shared session drives the Codex app-server through cli/src/codex/shared,
 * whose SettingsSchema has no `proactiveMultiAgent` field: this Codex build
 * exposes an "Ultra" reasoning effort instead of a multi-agent toggle. Listing
 * /agent without hiding it here meant the menu advertised a command that could
 * only fail, so the filter is scoped to sharedCodex rather than dropping the
 * entry for the legacy per-session launcher.
 */
const SHARED_CODEX_UNSUPPORTED_COMMANDS: ReadonlySet<string> = new Set(['agent'])

export function isSlashCommandUnavailable(
    name: string,
    agent: string,
    options: { sharedCodex?: boolean } = {},
): boolean {
    if (!options.sharedCodex || agent !== 'codex') return false
    return SHARED_CODEX_UNSUPPORTED_COMMANDS.has(name.toLowerCase())
}

export function filterUnavailableSlashCommands<T extends SlashCommand>(
    commands: readonly T[],
    agent: string,
    options: { sharedCodex?: boolean } = {},
): T[] {
    if (!options.sharedCodex || agent !== 'codex') return [...commands]
    return commands.filter((command) => !SHARED_CODEX_UNSUPPORTED_COMMANDS.has(command.name.toLowerCase()))
}
