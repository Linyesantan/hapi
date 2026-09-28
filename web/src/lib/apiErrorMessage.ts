import { ApiError } from '@/api/client'

export function apiErrorMessage(error: unknown, fallback: string): string {
    if (error instanceof ApiError && error.body) {
        try {
            const body: unknown = JSON.parse(error.body)
            if (body && typeof body === 'object' && 'error' in body
                && typeof body.error === 'string' && body.error.trim()) return body.error
        } catch { /* Non-JSON errors retain their original message. */ }
    }
    return error instanceof Error ? error.message : fallback
}
