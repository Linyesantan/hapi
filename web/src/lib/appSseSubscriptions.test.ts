import { describe, expect, it } from 'vitest'
import { getAppSseSubscription } from './appSseSubscriptions'

describe('app SSE subscriptions', () => {
    it('keeps global state without subscribing to every conversation body on the list page', () => {
        expect(getAppSseSubscription(null)).toEqual({ all: true, selectedMessagesOnly: true })
        expect(getAppSseSubscription(undefined)).toEqual({ all: true, selectedMessagesOnly: true })
    })

    it('combines global state and the selected conversation in one stream', () => {
        expect(getAppSseSubscription('session-a')).toEqual({ all: true, selectedMessagesOnly: true, sessionId: 'session-a' })
    })
})
