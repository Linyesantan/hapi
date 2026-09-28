import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'
import type { NativeCodexTerminalState, NativeTerminalRequest } from '@hapi/protocol/apiTypes'
import { findOwners, parseNativeCodexQueue, processGeneration, stillOwnsTranscript, type NativeCodexOwner } from './nativeCodexTerminal'
import { parseNativeModelMenu } from './nativeTerminalMenu'

export type NativeTerminalCommand = (args: string[], input?: string) => Promise<string>
export type NativeTerminalOptions = {
    procRoot?: string
    codexHome?: string
    opencodeDatabase?: string
    run?: NativeTerminalCommand
    canRead?: (session: { cwd: string; file: string }) => boolean | Promise<boolean>
}
type Owner = NativeCodexOwner & NativeTerminalRequest
export type NativeTerminalTarget = Owner & {
    socket: string; pane: string; binding: string; command: string; panePid: string
    columns: number; rows: number; cursorX: number; cursorY: number
    title: string; mode: string; inputOff: string
}

export const runNativeTmux: NativeTerminalCommand = (args, input) => new Promise((resolve, reject) => {
    const child = execFile('tmux', args, { timeout: 1_500, maxBuffer: 256 * 1024, encoding: 'utf8' }, (error, stdout) => {
        if (error) reject(error)
        else resolve(stdout)
    })
    child.stdin?.on('error', () => {})
    child.stdin?.end(input)
})

const TMUX_FORMAT = '#{pane_id}|#{pane_tty}|#{pane_width}|#{pane_height}|#{pane_in_mode}|#{cursor_x}|#{cursor_y}|#{pane_current_command}|#{pane_pid}|#{pane_input_off}|#{pane_title}'
export const nativePlainText = (value: string) => value.replace(/\x1b\[[0-9;:]*[a-zA-Z]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')

async function targetFor(owner: Owner, options: NativeTerminalOptions): Promise<NativeTerminalTarget | null> {
    if (!owner.foreground || owner.ambiguous || !/^\/dev\/(?:pts\/\d+|tty\d+)$/.test(owner.tty)) return null
    try {
        const environment = readFileSync(join(owner.root, 'environ'), 'utf8').split('\0')
        const socket = environment.find(value => value.startsWith('TMUX='))?.slice(5).split(',')[0]
        const pane = environment.find(value => value.startsWith('TMUX_PANE='))?.slice(10)
        if (!socket || !isAbsolute(socket) || !pane || !/^%\d+$/.test(pane)) return null
        const values = (await (options.run ?? runNativeTmux)(['-S', socket, 'display-message', '-p', '-t', pane, TMUX_FORMAT])).trimEnd().split('|')
        if (values[0] !== pane || values[1] !== owner.tty || !stillOwnsTranscript(owner)) return null
        const columns = Number(values[2]), rows = Number(values[3]), cursorX = Number(values[5]), cursorY = Number(values[6])
        if (![columns, rows, cursorX, cursorY].every(Number.isInteger) || columns < 1 || rows < 1) return null
        if (!/^\d+$/.test(values[8] ?? '') || !/^[a-zA-Z0-9_.+-]+$/.test(values[7] ?? '')) return null
        const binding = createHash('sha256').update([owner.agent, owner.sessionId, owner.root, owner.generation, owner.file, socket, pane, owner.tty, values[8]].join('\0')).digest('hex')
        return { ...owner, socket, pane, binding, columns, rows, cursorX, cursorY,
            mode: values[4], command: values[7], panePid: values[8], inputOff: values[9], title: values.slice(10).join('|') }
    } catch { return null }
}

/** OpenCode keeps all histories in one DB, so an open DB alone proves nothing.
 * Match the TUI's exact OSC title against a unique session in that process's
 * directory. A duplicate title or an overlay/unknown title is not guessed. */
export async function findRunningOpencodeTargets(options: NativeTerminalOptions = {}): Promise<NativeTerminalTarget[]> {
    const targets: NativeTerminalTarget[] = []
    const procRoot = options.procRoot ?? '/proc'
    let database: string
    try { database = realpathSync(options.opencodeDatabase ?? join(process.env.XDG_DATA_HOME || join(homedir(), '.local/share'), 'opencode/opencode.db')) } catch { return targets }
    let pids: string[]
    try { pids = readdirSync(procRoot) } catch { return targets }
    const { Database } = await import('bun:sqlite')
    const db = new Database(database, { readonly: true })
    try {
        for (const pid of pids) {
            if (!/^\d+$/.test(pid)) continue
            const root = join(procRoot, pid)
            try {
                if (process.getuid && statSync(root).uid !== process.getuid()) continue
                if (!/^opencode(?:\.exe)?$/.test(basename(readlinkSync(join(root, 'exe'))).replace(/ \(deleted\)$/, ''))) continue
                const identity = processGeneration(root)
                if (!identity.foreground || !identity.generation) continue
                const owner: Owner = { root, ...identity, agent: 'opencode', sessionId: '', file: database, ambiguous: false,
                    cwd: readlinkSync(join(root, 'cwd')), tty: readlinkSync(join(root, 'fd/0')) }
                if (!stillOwnsTranscript(owner) || options.canRead && !await options.canRead(owner)) continue
                const target = await targetFor(owner, options)
                if (!target?.title.startsWith('OC | ')) continue
                const rows = db.query<{ id: string }, [string, string]>(
                    'SELECT id FROM session WHERE title = ? AND directory = ?'
                ).all(target.title.slice(5), owner.cwd)
                if (rows.length !== 1 || !/^ses_[a-zA-Z0-9]+$/.test(rows[0].id)) continue
                const verified = await targetFor({ ...owner, sessionId: rows[0].id }, options)
                if (verified?.title === target.title) targets.push(verified)
            } catch { /* A terminal can close or change its selected session. */ }
        }
    } finally { db.close() }
    return targets
}

export async function resolveNativeTerminal(request: NativeTerminalRequest, options: NativeTerminalOptions = {}) {
    if (request.agent === 'opencode') {
        const matches = (await findRunningOpencodeTargets(options)).filter(target => target.sessionId === request.sessionId)
        return { running: matches.length > 0, target: matches.length === 1 ? matches[0] : null }
    }
    let owners: NativeCodexOwner[]
    try { owners = findOwners(request.sessionId, options.procRoot ?? '/proc', options.codexHome ?? (process.env.CODEX_HOME?.trim() || join(homedir(), '.codex'))) } catch { owners = [] }
    const allowed: Owner[] = []
    for (const owner of owners) {
        if (!options.canRead || await options.canRead(owner)) allowed.push({ ...owner, ...request })
    }
    return { running: allowed.length > 0, target: allowed.length === 1 ? await targetFor(allowed[0], options) : null }
}

export function nativeInputReason(target: NativeTerminalTarget, raw: string): string | undefined {
    if (target.mode !== '0') return '原终端正在 tmux 翻阅模式，退出该模式后即可发送。'
    if (target.inputOff !== '0') return '原终端暂时禁用了输入。'
    const lines = raw.split('\n')
    if (target.agent === 'codex') {
        const line = lines[target.cursorY] ?? ''
        const plain = nativePlainText(line).trimEnd()
        // Require the real cursor at the empty composer AND Codex's dim
        // placeholder styling. Never overwrite a draft, selection or approval.
        if (target.cursorX !== 2 || !/^›(?:\s|$)/.test(plain)) return '原终端当前没有空闲输入框，请先关闭终端中的菜单或完成当前输入。'
        const rest = plain.slice(1).trim()
        if (rest && (!/\x1b\[(?:[0-9;]*;)?2m/.test(line) || !/^(?:Ask Codex to do anything|Ask anything|Write tests for |Explain |Implement |Find and fix |Summarize |Run |Improve |Type )/.test(rest))) {
            return '原终端已有未发送草稿，手机不会覆盖；请先在原终端处理。'
        }
        return undefined
    }
    const plain = lines.map(nativePlainText)
    let bottom = -1
    for (let i = plain.length - 1; i >= Math.max(0, plain.length - 12); i--) {
        if (/^\s*╹▀/.test(plain[i])) { bottom = i; break }
    }
    const cursor = plain[target.cursorY] ?? ''
    if (bottom < 0 || target.cursorX !== 5 || target.cursorY < bottom - 7 || target.cursorY >= bottom
        || !/^\s*┃\s*$/.test(cursor)) return 'OpenCode 输入区暂时不可用，请先关闭原终端菜单或处理已有草稿。'
    for (let i = target.cursorY; i < bottom; i++) {
        if (/^\s*┃\s*$/.test(plain[i])) continue
        if (/^\s*┃\s*(?:Build|Plan|[A-Za-z][\w-]*)\s*[·:]/.test(plain[i])) return undefined
        return 'OpenCode 原终端已有输入，手机不会覆盖。'
    }
    return '暂时无法确认 OpenCode 输入区。'
}

/** Composer contents only, excluding transcript and model/status labels. */
export function nativeComposerText(target: NativeTerminalTarget, raw: string): string | null {
    const lines = raw.split('\n').map(nativePlainText)
    if (target.agent === 'codex') {
        let start = target.cursorY
        while (start >= Math.max(0, target.cursorY - 30) && !/^›(?:\s|$)/.test(lines[start] ?? '')) start--
        if (start < 0 || !/^›(?:\s|$)/.test(lines[start] ?? '')) return null
        return lines.slice(start, target.cursorY + 1).map((line, index) => index === 0 ? line.slice(2) : line.trimStart()).join('\n').trimEnd()
    }
    let bottom = -1
    for (let index = lines.length - 1; index >= 0; index--) {
        if (/^\s*╹▀/.test(lines[index])) { bottom = index; break }
    }
    if (bottom < 0 || target.cursorY >= bottom || !/^\s*┃/.test(lines[target.cursorY] ?? '')) return null
    let top = target.cursorY
    while (top > 0 && /^\s*┃/.test(lines[top - 1]) && !/Switch model|\/models/.test(lines[top - 1])) top--
    while (bottom > top && !/^\s*┃\s*(?:Build|Plan|[A-Za-z][\w-]*)\s*[·:]/.test(lines[bottom - 1])) bottom--
    if (bottom <= top) return null
    return lines.slice(top, bottom - 1).map(line => line.replace(/^\s*┃\s?/, '').trimEnd()).join('\n').trim()
}

export function nativeTmuxCondition(target: NativeTerminalTarget) {
    return [
        `#{==:#{pane_id},${target.pane}}`, `#{==:#{pane_tty},${target.tty}}`,
        `#{==:#{pane_pid},${target.panePid}}`, `#{==:#{pane_current_command},${target.command}}`,
        '#{==:#{pane_in_mode},0}', '#{==:#{pane_input_off},0}'
    ].reduce((left, right) => `#{&&:${left},${right}}`)
}

export async function readNativeTerminalSnapshot(request: NativeTerminalRequest, options: NativeTerminalOptions = {}) {
    const resolved = await resolveNativeTerminal(request, options)
    const state: NativeCodexTerminalState = { sessionId: request.sessionId, checkedAt: Date.now(), running: resolved.running,
        input: { available: false, reason: resolved.running ? '暂时无法确认原终端的输入区。' : '原终端未运行。' },
        queue: { status: 'unavailable', messages: [], note: '暂时无法读取原终端队列。' } }
    const target = resolved.target
    if (!target) return { state, target: null, raw: '' }
    try {
        const raw = await (options.run ?? runNativeTmux)(['-S', target.socket, 'capture-pane', '-p', '-e', '-t', target.pane, '-S', '0'])
        const checked = await targetFor(target, options)
        // Codex animates its OSC title while working. Its transcript and
        // process generation establish identity; the spinner is not identity.
        // OpenCode's title is part of the exact-session binding, so retain it.
        if (!checked || checked.binding !== target.binding
            || request.agent === 'opencode' && checked.title !== target.title) return { state, target: null, raw: '' }
        const text = nativePlainText(raw).trimEnd()
        const reason = nativeInputReason(checked, raw)
        state.busy = /\besc(?:ape)?\s+(?:(?:again|to)\s+)*(?:interrupt|stop|cancel)\b/i.test(text.split('\n').slice(-25).join('\n'))
        state.input = { available: !reason, binding: target.binding, ...(reason ? { reason } : {}) }
        if (checked.mode === '0') {
            state.terminal = { text, columns: target.columns, rows: target.rows }
            if (reason && checked.inputOff === '0') state.modelMenu = parseNativeModelMenu(request.agent, raw, checked.columns)
            state.queue = request.agent === 'codex' ? parseNativeCodexQueue(text)
                : { status: 'unavailable', messages: [], note: 'OpenCode 的待发送内容可在原终端画面中查看。' }
        } else state.queue.note = reason
        state.checkedAt = Date.now()
        return { state, target: checked, raw }
    } catch { return { state, target: null, raw: '' } }
}
