import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { withNativeHistoryState } from './nativeHistoryState'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))

describe('native history process evidence', () => {
    it('requires an agent process holding the exact transcript, and expires when its descriptor closes', () => {
        const root = mkdtempSync(join(tmpdir(), 'hapi-history-state-'))
        roots.push(root)
        const files = ['current.jsonl', 'recent.jsonl'].map(name => join(root, name))
        files.forEach(file => writeFileSync(file, '{}'))
        for (const [pid, executable, file] of [['123', '/bin/codex', files[0]], ['456', '/bin/editor', files[1]]]) {
            mkdirSync(join(root, pid, 'fd'), { recursive: true })
            symlinkSync(executable, join(root, pid, 'exe'))
            symlinkSync(file, join(root, pid, 'fd', '4'))
        }
        const sessions = files.map(file => ({ file }))
        expect(withNativeHistoryState(sessions, 'codex', root).map(item => item.sourceState.state)).toEqual(['running', 'unknown'])
        unlinkSync(join(root, '123', 'fd', '4'))
        expect(withNativeHistoryState(sessions, 'codex', root).map(item => item.sourceState.state)).toEqual(['unknown', 'unknown'])
    })

    it('keeps unreadable process state unknown instead of claiming the terminal is offline', () => {
        expect(withNativeHistoryState([{ file: '/tmp/history.jsonl' }], 'codex', '/no-such-proc-root')[0].sourceState)
            .toMatchObject({ state: 'unknown', checkedAt: expect.any(Number) })
    })
})
