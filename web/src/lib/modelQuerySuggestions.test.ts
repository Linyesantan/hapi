import { describe, it, expect, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import { getModelQuerySuggestions, supportsModelQueryAutocomplete } from './modelQuerySuggestions'

function apiWithCatalog(overrides: Record<string, unknown> = {}) {
    return {
        getSessionOpencodeModels: vi.fn(async () => ({
            success: true,
            availableModels: [
                { modelId: 'opencode/space-bunny-free', name: 'OpenCode Zen/Space Bunny Free' },
                { modelId: 'tokenrhythm2/glm-5.3' },
                { modelId: 'kimi/kimi-k2-thinking' }
            ],
            currentModelId: 'kimi/kimi-k2-thinking',
            ...overrides
        })),
        getSessionCodexModels: vi.fn(async () => ({ success: true, availableModels: [] })),
        getSessionCursorModels: vi.fn(async () => ({ success: true, availableModels: [] }))
    } as unknown as ApiClient
}

describe('supportsModelQueryAutocomplete', () => {
    it('covers only flavors with a session-scoped catalog endpoint', () => {
        expect(supportsModelQueryAutocomplete('opencode')).toBe(true)
        expect(supportsModelQueryAutocomplete('codex')).toBe(true)
        expect(supportsModelQueryAutocomplete('cursor')).toBe(true)
        expect(supportsModelQueryAutocomplete('claude')).toBe(false)
        expect(supportsModelQueryAutocomplete(undefined)).toBe(false)
    })
})

describe('getModelQuerySuggestions', () => {
    it('inserts a complete /model invocation and marks the current model', async () => {
        const suggestions = await getModelQuerySuggestions({
            api: apiWithCatalog(),
            sessionId: 's1',
            flavor: 'opencode',
            keyword: ''
        })
        expect(suggestions.map(s => s.text)).toEqual([
            '/model opencode/space-bunny-free',
            '/model tokenrhythm2/glm-5.3',
            '/model kimi/kimi-k2-thinking'
        ])
        expect(suggestions[0].label).toBe('OpenCode Zen/Space Bunny Free')
        expect(suggestions[0].description).toBe('OpenCode Zen/Space Bunny Free')
        expect(suggestions[2].description).toBe('current')
    })

    it('filters by keyword using the shared ranker', async () => {
        const suggestions = await getModelQuerySuggestions({
            api: apiWithCatalog(),
            sessionId: 's1',
            flavor: 'opencode',
            keyword: 'glm'
        })
        expect(suggestions).toHaveLength(1)
        expect(suggestions[0].text).toBe('/model tokenrhythm2/glm-5.3')
        expect(suggestions[0].label).toBe('tokenrhythm2/glm-5.3')
    })

    it('returns nothing when the keyword matches no model', async () => {
        const suggestions = await getModelQuerySuggestions({
            api: apiWithCatalog(),
            sessionId: 's1',
            flavor: 'opencode',
            keyword: 'zzzznope'
        })
        expect(suggestions).toEqual([])
    })

    it('stays silent for flavors without a session catalog and without a session', async () => {
        const api = apiWithCatalog()
        expect(await getModelQuerySuggestions({ api, sessionId: 's1', flavor: 'claude', keyword: '' })).toEqual([])
        expect(await getModelQuerySuggestions({ api, sessionId: null, flavor: 'opencode', keyword: '' })).toEqual([])
        expect(await getModelQuerySuggestions({ api: null, sessionId: 's1', flavor: 'opencode', keyword: '' })).toEqual([])
    })

    it('swallows catalog errors instead of breaking the composer', async () => {
        const api = {
            getSessionOpencodeModels: vi.fn(async () => { throw new Error('boom') })
        } as unknown as ApiClient
        expect(await getModelQuerySuggestions({ api, sessionId: 's1', flavor: 'opencode', keyword: '' })).toEqual([])
    })

    it('treats a failed catalog response as empty', async () => {
        const api = apiWithCatalog({ success: false, error: 'nope' })
        expect(await getModelQuerySuggestions({ api, sessionId: 's1', flavor: 'opencode', keyword: '' })).toEqual([])
    })
})
