/**
 * Shared model-catalog matching used by both the CLI `/model` picker and the
 * web composer autocomplete. Keeping one implementation matters: the CLI
 * answers `/model <keyword>` in a terminal while the web answer shows up as a
 * suggestion list, and they must rank and cap identically or the same query
 * would resolve to different models depending on the surface.
 */

export interface ModelCatalogEntry {
    modelId: string;
    name?: string;
}

export const MODEL_QUERY_LIMIT = 12;

function normalize(value: string): string {
    return value.trim().toLowerCase();
}

function isSubsequence(needle: string, haystack: string): boolean {
    let index = 0;
    for (const char of haystack) {
        if (char === needle[index]) index += 1;
        if (index === needle.length) return true;
    }
    return needle.length === 0;
}

/**
 * Rank a candidate against a query. An exact match wins over a substring, which
 * wins over a loose subsequence, so "kimi" still finds "kimi-k2-thinking" while
 * a literal "k2" beats it. The returned score doubles as the sort key, which
 * means a better match always sorts ahead of a worse one regardless of the
 * underlying catalog order.
 */
function score(query: string, candidate: string): number | null {
    const q = normalize(query);
    const c = normalize(candidate);
    if (!q) return 2;
    if (c === q) return 0;
    const substringIndex = c.indexOf(q);
    if (substringIndex >= 0) return 1 + substringIndex / 1000;
    if (isSubsequence(q, c)) return 2;
    return null;
}

function matchScore(query: string, entry: ModelCatalogEntry): number | null {
    const byId = score(query, entry.modelId);
    const byName = entry.name ? score(query, entry.name) : null;
    if (byId === null && byName === null) return null;
    return Math.min(byId ?? Number.POSITIVE_INFINITY, byName ?? Number.POSITIVE_INFINITY);
}

/**
 * Filter and rank a model catalog against a free-form query. An empty query
 * keeps the catalog in its original order.
 */
export function filterModelCatalog<T extends ModelCatalogEntry>(
    models: readonly T[],
    query: string
): T[] {
    const q = normalize(query);
    return models
        .map((entry, index) => ({ entry, index, score: matchScore(q, entry) }))
        .filter((candidate): candidate is { entry: T; index: number; score: number } => candidate.score !== null)
        .sort((a, b) => (a.score === b.score ? a.index - b.index : a.score - b.score))
        .map(candidate => candidate.entry);
}

/** True when a `/…` composer query is asking for model arguments. */
export function parseModelQuery(text: string): { keyword: string } | null {
    const match = /^\/model(?:\s+(.*))?$/i.exec(text.trim());
    if (!match) return null;
    return { keyword: (match[1] ?? '').trim() };
}
