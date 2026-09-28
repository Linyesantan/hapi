import type { AuthResponse } from '@/types/api'

const PREFIX = 'hapi_offline_auth::'

async function fingerprint(accessToken: string): Promise<string> {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(accessToken))
    return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function rememberOfflineAuth(baseUrl: string, accessToken: string, auth: AuthResponse): Promise<void> {
    try {
        localStorage.setItem(PREFIX + baseUrl, JSON.stringify({ fingerprint: await fingerprint(accessToken), auth }))
        // Request durable browser storage after the first successful login.
        void navigator.storage?.persist?.().catch(() => {})
    } catch { /* private mode or unavailable storage must not break online login */ }
}

export async function readOfflineAuth(baseUrl: string, accessToken: string): Promise<AuthResponse | null> {
    try {
        const record = JSON.parse(localStorage.getItem(PREFIX + baseUrl) ?? 'null') as {
            fingerprint?: string; auth?: AuthResponse
        } | null
        if (record?.fingerprint !== await fingerprint(accessToken)) return null
        return typeof record.auth?.token === 'string' && typeof record.auth.user?.id === 'number' ? record.auth : null
    } catch { return null }
}

export function forgetOfflineAuth(baseUrl: string): void {
    try { localStorage.removeItem(PREFIX + baseUrl) } catch { /* best effort */ }
}
