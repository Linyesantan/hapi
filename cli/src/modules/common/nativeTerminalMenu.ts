import { createHash } from 'node:crypto'
import type { NativeModelMenu, NativeTerminalRequest } from '@hapi/protocol/apiTypes'

/** Only known TUI menu headings qualify; transcript mentions are not controls. */
export function parseNativeModelMenu(agent: NativeTerminalRequest['agent'], raw: string, columns: number): NativeModelMenu | undefined {
    const lines = raw.split('\n')
    const plain = lines.map(line => line.replace(/\x1b\[[0-9;:]*[a-zA-Z]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ''))
    const titlePattern = agent === 'codex'
        ? /^\s*[│┃]?\s*(Select Model(?: and Effort)?|Select Reasoning Level for .+?|Advanced Reasoning|Apply reasoning change)\s*[│┃]?\s*$/
        : /^\s*[│┃]?\s*(Select model|Select variant)\s*(?:esc(?:\s+close)?)?\s*[│┃]?\s*$/
    let start = -1
    let title = ''
    for (let index = 0; index < plain.length; index++) {
        const match = titlePattern.exec(plain[index])
        if (match) { start = index; title = match[1].trim() }
    }
    if (start < 0 || !/\x1b\[[0-9;:]*m/.test(lines.slice(start).join('\n'))) return undefined
    const text = plain.slice(start).join('\n').trimEnd()
    // Codex displays selectable rows; OpenCode shows its dialog's Esc hint.
    if (agent === 'codex' && !/(?:^|\n)\s*[›❯>]?\s*(?:\d+\.|[●○])\s+\S/m.test(text)) return undefined
    if (agent === 'opencode' && !/\besc\b/i.test(text)) return undefined
    const ansi = lines.slice(start).join('\n').trimEnd()
    return { kind: /Reasoning|reasoning|variant/.test(title) ? 'effort' : 'model', title, text, ansi, columns,
        fingerprint: createHash('sha256').update(`${columns}\0${ansi}`).digest('hex') }
}
