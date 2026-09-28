import { describe, expect, test } from 'bun:test'
import { AGENT_FLAVORS } from './modes'
import {
    BUILTIN_SLASH_COMMANDS,
    filterUnavailableSlashCommands,
    getBuiltinSlashCommands,
    isSlashCommandUnavailable,
    mergeSlashCommands,
    parseSlashCommand
} from './slashCommands'

describe('getBuiltinSlashCommands', () => {
    // The catalog is typed as Record<AgentFlavor, ...>, so TypeScript already
    // rejects a missing flavor. This asserts the runtime invariant that makes
    // the fallback safe: every flavor resolves to its own list, never another
    // agent's.
    test('every agent flavor has an entry and resolves to it', () => {
        for (const flavor of AGENT_FLAVORS) {
            const expected = BUILTIN_SLASH_COMMANDS[flavor].map((command) => ({ ...command }))
            expect(getBuiltinSlashCommands(flavor)).toEqual(expected)
        }
    })

    test('flavors with no command support return an empty list', () => {
        // agy runs headless (`agy -p`) so its TUI slash commands are unreachable;
        // dsh speaks ACP, whose session/prompt has no command channel; kimi
        // likewise. None of them has a resolver, so listing commands would
        // advertise features that get sent to the model as literal text.
        expect(getBuiltinSlashCommands('agy')).toEqual([])
        expect(getBuiltinSlashCommands('dsh')).toEqual([])
        expect(getBuiltinSlashCommands('kimi')).toEqual([])
    })

    test('unknown agents get an empty list instead of the claude catalog', () => {
        expect(getBuiltinSlashCommands('not-a-flavor')).toEqual([])
        expect(getBuiltinSlashCommands('')).toEqual([])
    })

    test('returns defensive copies', () => {
        const first = getBuiltinSlashCommands('claude')
        first[0]!.name = 'mutated'
        expect(getBuiltinSlashCommands('claude')[0]!.name).not.toBe('mutated')
    })
})

describe('mergeSlashCommands', () => {
    test('later entries win case-insensitively and move to the end', () => {
        const merged = mergeSlashCommands([
            { name: 'clear', source: 'builtin' },
            { name: 'status', source: 'builtin' },
            { name: 'CLEAR', source: 'project', content: 'custom' }
        ])

        expect(merged).toEqual([
            { name: 'status', source: 'builtin' },
            { name: 'CLEAR', source: 'project', content: 'custom' }
        ])
    })
})

describe('isSlashCommandUnavailable', () => {
    test('scopes the shared codex /agent restriction to shared sessions', () => {
        expect(isSlashCommandUnavailable('agent', 'codex', { sharedCodex: true })).toBe(true)
        expect(isSlashCommandUnavailable('Agent', 'codex', { sharedCodex: true })).toBe(true)
        expect(isSlashCommandUnavailable('agent', 'codex')).toBe(false)
        expect(isSlashCommandUnavailable('agent', 'claude', { sharedCodex: true })).toBe(false)
    })
})

describe('filterUnavailableSlashCommands', () => {
    const commands = [
        { name: 'agent', source: 'builtin' as const },
        { name: 'plan', source: 'builtin' as const }
    ]

    test('drops only what the session cannot execute', () => {
        expect(filterUnavailableSlashCommands(commands, 'codex', { sharedCodex: true }))
            .toEqual([{ name: 'plan', source: 'builtin' }])
    })

    test('is a no-op otherwise and does not mutate its input', () => {
        const input = [...commands]
        expect(filterUnavailableSlashCommands(input, 'codex')).toEqual(commands)
        expect(filterUnavailableSlashCommands(input, 'claude', { sharedCodex: true })).toEqual(commands)
        expect(input).toEqual(commands)
    })
})

describe('parseSlashCommand', () => {
    test('parses a bare command and lowercases the name', () => {
        expect(parseSlashCommand('/compact')).toEqual({ name: 'compact', rest: '' })
        expect(parseSlashCommand('  /COMPACT  ')).toEqual({ name: 'compact', rest: '' })
    })

    test('captures and trims arguments', () => {
        expect(parseSlashCommand('/model  gpt-5.4 ')).toEqual({ name: 'model', rest: 'gpt-5.4' })
        expect(parseSlashCommand('/compact now please')).toEqual({ name: 'compact', rest: 'now please' })
    })

    test('keeps namespace separators inside the name', () => {
        expect(parseSlashCommand('/plugin:review')).toEqual({ name: 'plugin:review', rest: '' })
        expect(parseSlashCommand('/a:b:c x')).toEqual({ name: 'a:b:c', rest: 'x' })
    })

    test('does not treat a file path as a command', () => {
        // The whole message must be the command, so `.md` (or any other
        // non-space suffix) makes it a plain prompt instead.
        expect(parseSlashCommand('/compact.md')).toBeNull()
        expect(parseSlashCommand('/plan.md')).toBeNull()
        expect(parseSlashCommand('/compact.md and more')).toBeNull()
    })

    test('rejects text that is not a command', () => {
        expect(parseSlashCommand('/')).toBeNull()
        expect(parseSlashCommand('show me /compact')).toBeNull()
        expect(parseSlashCommand('compact')).toBeNull()
        expect(parseSlashCommand('')).toBeNull()
    })

    test('a single space already separates arguments', () => {
        expect(parseSlashCommand('/comp act')).toEqual({ name: 'comp', rest: 'act' })
    })
})
