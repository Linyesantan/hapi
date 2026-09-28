import { describe, expect, it } from 'vitest'
import { getPermissionModesForFlavor } from '@hapi/protocol/modes'
import {
    isSlashCommandUnavailable,
    filterUnavailableSlashCommands,
    getBuiltinSlashCommands,
    mergeSlashCommands
} from './codexSlashCommands'

describe('getBuiltinSlashCommands', () => {
    it('exposes HAPI-supported codex built-ins in remote web mode', () => {
        expect(getBuiltinSlashCommands('codex').map((command) => command.name)).toEqual(expect.arrayContaining([
            'clear',
            'compact',
            'goal',
            'plan',
            'status',
            'execute',
            'effort',
            'permission',
        ]))
    })

    // Every Cursor pass-through command must be discoverable, not just /compress.
    it('exposes every Cursor pass-through builtin', () => {
        expect(getBuiltinSlashCommands('cursor').map((command) => command.name)).toEqual([
            'compress',
            'compact',
            'summarize',
            'model',
            'multitask',
            'best-of-n',
            'worktree',
            'apply-worktree',
            'delete-worktree',
            'add-dir',
            'context',
            'fork',
            'auto-review'
        ])
    })

    // copilot's /help is generated from the builtin catalog, so a command that
    // the resolver implements but the catalog omits is missing from /help too.
    it('exposes the copilot mode commands the resolver implements', () => {
        const names = getBuiltinSlashCommands('copilot').map((command) => command.name)
        expect(names).toEqual(expect.arrayContaining(['interactive', 'default', 'mode']))
    })

    it('keeps pi builtins as its own list (no Claude fallback)', () => {
        const commands = getBuiltinSlashCommands('pi')
        expect(commands.length).toBeGreaterThan(0)
        expect(commands.map((command) => command.name)).not.toContain('clear')
        expect(commands.map((command) => command.name)).toContain('compact')
    })

    it('does not fall back to Claude commands for kimi', () => {
        expect(getBuiltinSlashCommands('kimi')).toEqual([])
    })

    // agy runs `agy -p <prompt>` headless (its TUI, where the native slash
    // commands live, is never started) and dsh speaks ACP, whose session/prompt
    // has no command channel. Neither has a resolver, so any command listed here
    // would be sent to the model as literal text.
    it('does not fall back to Claude commands for agy or dsh', () => {
        expect(getBuiltinSlashCommands('agy')).toEqual([])
        expect(getBuiltinSlashCommands('dsh')).toEqual([])
    })

    it('returns an empty list for an unknown agent instead of guessing claude', () => {
        expect(getBuiltinSlashCommands('not-a-real-agent')).toEqual([])
    })

    it('includes debug only in Cursor permission modes', () => {
        expect(getPermissionModesForFlavor('cursor')).toContain('debug')
        expect(getPermissionModesForFlavor('claude')).not.toContain('debug')
    })
})

describe('mergeSlashCommands', () => {
    it('lets custom commands override same-name built-ins', () => {
        const commands = mergeSlashCommands([
            { name: 'clear', source: 'builtin' },
            { name: 'compact', source: 'builtin' },
            { name: 'clear', source: 'project', content: 'project clear prompt' }
        ])

        expect(commands).toEqual([
            { name: 'compact', source: 'builtin' },
            { name: 'clear', source: 'project', content: 'project clear prompt' }
        ])
    })

    it('keeps API-provided built-ins while de-duplicating by name', () => {
        const commands = mergeSlashCommands([
            { name: 'clear', source: 'builtin' },
            { name: 'status', source: 'builtin' },
            { name: 'help', source: 'builtin' },
            { name: 'status', source: 'builtin', description: 'Captured status' },
            { name: 'project-only', source: 'project', content: 'Project prompt' }
        ])

        expect(commands).toEqual([
            { name: 'clear', source: 'builtin' },
            { name: 'help', source: 'builtin' },
            { name: 'status', source: 'builtin', description: 'Captured status' },
            { name: 'project-only', source: 'project', content: 'Project prompt' }
        ])
    })

})

describe('isSlashCommandUnavailable', () => {
    it('hides /agent only for a shared codex session', () => {
        expect(isSlashCommandUnavailable('agent', 'codex', { sharedCodex: true })).toBe(true)
        expect(isSlashCommandUnavailable('AGENT', 'codex', { sharedCodex: true })).toBe(true)
        // The legacy per-session launcher still supports the toggle.
        expect(isSlashCommandUnavailable('agent', 'codex', { sharedCodex: false })).toBe(false)
        // Only codex sessions are affected.
        expect(isSlashCommandUnavailable('agent', 'claude', { sharedCodex: true })).toBe(false)
        expect(isSlashCommandUnavailable('plan', 'codex', { sharedCodex: true })).toBe(false)
    })
})

describe('filterUnavailableSlashCommands', () => {
    const commands = [
        { name: 'agent', source: 'builtin' as const },
        { name: 'plan', source: 'builtin' as const },
        { name: 'status', source: 'builtin' as const }
    ]

    it('drops commands the session runtime cannot execute', () => {
        expect(filterUnavailableSlashCommands(commands, 'codex', { sharedCodex: true })
            .map((command) => command.name)).toEqual(['plan', 'status'])
    })

    it('is a no-op for non-codex sessions and for non-shared codex', () => {
        expect(filterUnavailableSlashCommands(commands, 'claude', { sharedCodex: true })).toEqual(commands)
        expect(filterUnavailableSlashCommands(commands, 'codex', { sharedCodex: false })).toEqual(commands)
        expect(filterUnavailableSlashCommands(commands, 'codex')).toEqual(commands)
    })

    it('does not mutate the input array', () => {
        const input = [...commands]
        filterUnavailableSlashCommands(input, 'codex', { sharedCodex: true })
        expect(input).toEqual(commands)
    })
})

