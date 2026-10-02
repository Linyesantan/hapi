import type { OpencodeModelsResponse } from '@hapi/protocol/apiTypes'
import { filterModelCatalog, MODEL_QUERY_LIMIT } from '@hapi/protocol/modelQuery'
import type { ApiClient } from '@/api/client'
import type { Suggestion } from '@/hooks/useActiveSuggestions'

type CatalogResponse = OpencodeModelsResponse

/**
 * Flavors whose model catalog the hub can resolve for a live session. Flavors
 * without a session-scoped endpoint (agy, pi, kimi, grok, copilot, dsh) expose
 * their picker through the composer's own model button instead, so `/model`
 * autocomplete stays silent for them rather than guessing an endpoint.
 */
const SESSION_MODEL_FETCHERS: Record<string, (api: ApiClient, sessionId: string) => Promise<CatalogResponse>> = {
    opencode: (api, sessionId) => api.getSessionOpencodeModels(sessionId),
    codex: (api, sessionId) => api.getSessionCodexModels(sessionId),
    cursor: (api, sessionId) => api.getSessionCursorModels(sessionId)
}

export function supportsModelQueryAutocomplete(flavor: string | undefined): boolean {
    return Boolean(flavor && SESSION_MODEL_FETCHERS[flavor])
}

function describe(model: { modelId: string; name?: string }, currentModelId: string | null | undefined): string | undefined {
    const name = model.name && model.name !== model.modelId ? model.name : undefined
    const current = model.modelId === currentModelId ? ' · current' : ''
    const text = name ? `${name}${current}` : current.replace(/^ · /, '')
    return text || undefined
}

/**
 * Suggest models for `/model <keyword>` in the composer. The keyword is matched
 * with the same shared ranker the CLI `/model` picker uses, so the same query
 * highlights the same model on both surfaces.
 */
export async function getModelQuerySuggestions(args: {
    api: ApiClient | null
    sessionId: string | null
    flavor: string | undefined
    keyword: string
}): Promise<Suggestion[]> {
    const fetcher = args.flavor ? SESSION_MODEL_FETCHERS[args.flavor] : undefined
    if (!fetcher || !args.api || !args.sessionId) return []

    const response = await fetcher(args.api, args.sessionId).catch(() => null)
    if (!response?.success) return []

    const catalog = response.availableModels ?? []
    const currentModelId = response.currentModelId ?? null
    const matches = filterModelCatalog(catalog, args.keyword).slice(0, MODEL_QUERY_LIMIT)
    return matches.map(model => ({
        key: `model:${model.modelId}`,
        text: `/model ${model.modelId}`,
        label: model.name && model.name !== model.modelId ? model.name : model.modelId,
        description: describe(model, currentModelId)
    }))
}
