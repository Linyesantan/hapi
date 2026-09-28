import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative } from 'node:path'
import { promisify } from 'node:util'
import type { NativeCodexTerminalState } from '@hapi/protocol/apiTypes'

const execute = promisify(execFile)
type TerminalCommand = (args: string[]) => Promise<string>
export type NativeCodexOwner = { root: string; generation: string; tty: string; file: string; cwd: string; foreground: boolean; ambiguous: boolean }
type Owner = NativeCodexOwner

export function processGeneration(root: string): { generation: string; foreground: boolean } {
    const stat = readFileSync(join(root, 'stat'), 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)
    return { generation: fields[19], foreground: fields[2] === fields[5] && Number(fields[5]) > 0 }
}

export function findOwners(sessionId: string, procRoot: string, codexHome: string): Owner[] {
    const owners: Owner[] = []
    let sessionsRoot: string
    try { sessionsRoot = realpathSync(join(codexHome, 'sessions')) } catch { return owners }
    for (const pid of readdirSync(procRoot)) {
        if (!/^\d+$/.test(pid)) continue
        const root = join(procRoot, pid)
        try {
            if (process.getuid && statSync(root).uid !== process.getuid()) continue
            // npm can replace the executable while a native session keeps
            // running. Linux retains that inode with a " (deleted)" suffix.
            if (!/^codex(?:\.exe)?$/.test(basename(readlinkSync(join(root, 'exe'))).replace(/ \(deleted\)$/, ''))) continue
            const identity = processGeneration(root)
            if (!identity.generation) continue
            const openTranscripts = new Set<string>()
            let matchedFile: string | undefined
            for (const fd of readdirSync(join(root, 'fd'))) {
                let file: string
                try { file = readlinkSync(join(root, 'fd', fd)) } catch { continue }
                if (!file.endsWith('.jsonl')) continue
                const scoped = relative(sessionsRoot, file)
                if (scoped === '..' || scoped.startsWith('../') || isAbsolute(scoped)) continue
                openTranscripts.add(file)
                if (basename(file).endsWith(`-${sessionId}.jsonl`)) matchedFile = file
            }
            if (matchedFile) owners.push({ root, ...identity, file: matchedFile, ambiguous: openTranscripts.size > 1,
                cwd: readlinkSync(join(root, 'cwd')), tty: readlinkSync(join(root, 'fd', '0')) })
        } catch { /* A process can exit while it is being inspected. */ }
    }
    return owners
}

export function stillOwnsTranscript(owner: Owner): boolean {
    try {
        const current = processGeneration(owner.root)
        if (current.generation !== owner.generation || !current.foreground) return false
        return readdirSync(join(owner.root, 'fd')).some(fd => {
            try { return readlinkSync(join(owner.root, 'fd', fd)) === owner.file } catch { return false }
        })
    } catch { return false }
}

/** Read only the footer immediately above the current Codex composer.
 * Never treat queue-shaped text in scrollback/tool output as a live queue.
 * TUI queues are not part of the transcript: retain their visible wording.
 */
export function parseNativeCodexQueue(screen: string): NativeCodexTerminalState['queue'] {
    const lines = screen.replace(/\r/g, '').split('\n')
    let prompt = -1
    for (let index = lines.length - 1; index >= 0; index--) {
        if (/^\s*›(?:\s|$)/.test(lines[index])) { prompt = index; break }
    }
    if (prompt === -1) return { status: 'unavailable', messages: [], note: '原终端当前没有显示输入区，暂时无法核对队列。' }
    let heading = -1
    for (let index = prompt - 1; index >= 0; index--) {
        if (/^\s*[•●]?\s*(?:Messages to be submitted|Messages queued|Queued messages)(?:\s|\(|$)/i.test(lines[index])) {
            heading = index
            break
        }
        if (/^\s*›(?:\s|$)/.test(lines[index])) break
    }
    if (heading === -1) {
        if (lines.slice(Math.max(0, prompt - 15), prompt).some(line => /^\s*↳/.test(line))) {
            return { status: 'unavailable', messages: [], note: '终端显示了待提交内容，但队列标题暂时无法识别，可展开画面核对。' }
        }
        return { status: 'visible', messages: [] }
    }
    const messages: string[] = []
    for (const line of lines.slice(heading + 1, prompt)) {
        const entry = /^\s*↳\s?(.*)$/.exec(line)
        if (entry) { messages.push(entry[1]); continue }
        if (!line.trim()) continue
        if (messages.length === 0 && /^\s*(?:\(press|press\s|to\s|and\s|send\s|immediately\)|interrupt\s)/i.test(line)) continue
        if (messages.length > 0 && /^\s{2,}\S/.test(line) && !/^\s*[•●›]/.test(line)) {
            messages[messages.length - 1] += '\n' + line.trimStart()
            continue
        }
        // The heading was in previous output, or this CLI layout is unknown.
        return { status: 'unavailable', messages: [], note: '暂时无法识别原终端队列，可展开原终端画面核对。' }
    }
    return {
        status: 'visible',
        messages: messages.map((text, index) => ({
            id: createHash('sha256').update(`${index}\0${text}`).digest('hex').slice(0, 16), text
        })),
        ...(messages.length ? { note: '显示原终端当前可见的排队内容；长消息或附件可能由终端折叠。' } : {})
    }
}

export async function readNativeCodexTerminal(sessionId: string, options: {
    procRoot?: string
    codexHome?: string
    run?: TerminalCommand
    canRead?: (session: { cwd: string; file: string }) => boolean | Promise<boolean>
} = {}): Promise<NativeCodexTerminalState> {
    const state: NativeCodexTerminalState = {
        sessionId, checkedAt: Date.now(), running: false,
        queue: { status: 'unavailable', messages: [], note: '未找到正在运行的原终端。' }
    }
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sessionId)) return state
    const run = options.run ?? (async (args: string[]) => (await execute('tmux', args, {
        timeout: 1_200, maxBuffer: 128 * 1024, encoding: 'utf8'
    })).stdout)
    let owners: Owner[]
    try { owners = findOwners(sessionId, options.procRoot ?? '/proc', options.codexHome ?? (process.env.CODEX_HOME?.trim() || join(homedir(), '.codex'))) } catch { return state }
    for (const owner of owners) {
        if (options.canRead && !await options.canRead(owner)) continue
        state.running = true
        state.queue.note = '原终端没有可读取的 tmux 画面；不能据此认定队列为空。'
        if (owner.ambiguous) {
            state.queue.note = '该进程同时持有多个会话，暂时无法确认终端画面属于哪一条。'
            continue
        }
        if (!owner.foreground || !/^\/dev\/(?:pts\/\d+|tty\d+)$/.test(owner.tty)) continue
        try {
            // Read only the two tmux identifiers, never publish the environment.
            const environment = readFileSync(join(owner.root, 'environ'), 'utf8').split('\0')
            const socket = environment.find(value => value.startsWith('TMUX='))?.slice(5).split(',')[0]
            const pane = environment.find(value => value.startsWith('TMUX_PANE='))?.slice(10)
            if (!socket || !isAbsolute(socket) || !pane || !/^%\d+$/.test(pane)) continue
            const args = ['-S', socket]
            const metadata = (await run([...args, 'display-message', '-p', '-t', pane, '#{pane_id}|#{pane_tty}|#{pane_width}|#{pane_height}|#{pane_in_mode}'])).trim().split('|')
            if (metadata[0] !== pane || metadata[1] !== owner.tty || metadata[4] !== '0') continue
            const columns = Number(metadata[2]), rows = Number(metadata[3])
            if (!Number.isInteger(columns) || !Number.isInteger(rows) || columns < 1 || rows < 1) continue
            const text = (await run([...args, 'capture-pane', '-p', '-J', '-t', pane, '-S', '0']))
                .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trimEnd()
            if (!stillOwnsTranscript(owner)) continue
            return { ...state, checkedAt: Date.now(), terminal: { text, columns, rows }, queue: parseNativeCodexQueue(text) }
        } catch { /* No restart, attach, resize, keystroke, or process signal is used. */ }
    }
    return { ...state, checkedAt: Date.now() }
}
