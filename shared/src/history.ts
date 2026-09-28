/** Older Codex mirrors retain their original flag when the gateway is upgraded. */
export function isReadOnlyHistory(metadata: unknown): boolean {
    if (!metadata || typeof metadata !== 'object') return false
    return ('historyReadOnly' in metadata && metadata.historyReadOnly === true)
        || ('codexHistoryReadOnly' in metadata && metadata.codexHistoryReadOnly === true)
}
