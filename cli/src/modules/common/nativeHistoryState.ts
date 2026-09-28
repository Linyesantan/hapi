import { readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { HistorySourceState } from '@hapi/protocol/schemas'

/** Positive evidence only: an agent process holds this exact transcript open.
 * File timestamps and a process in the same directory do not establish ownership.
 */
export function withNativeHistoryState<T extends { file: string }>(
    sessions: T[],
    agent: 'codex' | 'pi',
    procRoot = '/proc'
): Array<T & { sourceState: HistorySourceState }> {
    if (sessions.length === 0) return []
    const checkedAt = Date.now()
    const openTranscripts = new Set<string>()
    const paths = new Map(sessions.map(session => {
        try { return [session.file, realpathSync(session.file)] } catch { return [session.file, session.file] }
    }))
    const wanted = new Set(paths.values())
    try {
        for (const pid of readdirSync(procRoot)) {
            if (!/^\d+$/.test(pid)) continue
            const root = join(procRoot, pid)
            try {
                if (process.getuid && statSync(root).uid !== process.getuid()) continue
                const executable = basename(readlinkSync(join(root, 'exe')))
                if (agent === 'codex' ? !/^codex(?:\.exe)?$/.test(executable) : !/^(?:pi|node|bun)(?:\.exe)?$/.test(executable)) continue
                if (agent === 'pi' && executable !== 'pi') {
                    const args = readFileSync(join(root, 'cmdline'), 'utf8').split('\0')
                    if (!args.some(arg => /[/\\]pi-coding-agent[/\\].*[/\\]cli\.js$/.test(arg))) continue
                }
                for (const fd of readdirSync(join(root, 'fd'))) {
                    try {
                        const path = readlinkSync(join(root, 'fd', fd))
                        if (path.endsWith('.jsonl') && wanted.has(path)) openTranscripts.add(path)
                    } catch { /* Process/file descriptor may disappear during the scan. */ }
                }
            } catch { /* Unreadable processes are not proof that a session stopped. */ }
        }
    } catch { /* Other operating systems can still browse history without a process claim. */ }
    return sessions.map(session => ({
        ...session,
        sourceState: { state: openTranscripts.has(paths.get(session.file)!) ? 'running' : 'unknown', checkedAt }
    }))
}
