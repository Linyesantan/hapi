import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { webcrypto } from 'node:crypto'
import { useAuth } from './useAuth'
import { readOfflineAuth, rememberOfflineAuth } from '@/lib/offline-auth'
import { setMessageWindowScope } from '@/lib/message-window-store'

const baseUrl = 'http://offline-auth.test'
const source = { type: 'accessToken' as const, token: 'previously-verified-access-token' }
const makeAuth = (exp: number) => ({ token: `header.${btoa(JSON.stringify({ uid: 42, ns: 'private', exp }))}.signature`, user: { id: 42 } })

beforeEach(() => {
    localStorage.clear()
    vi.stubGlobal('crypto', webcrypto)
})
afterEach(() => {
    cleanup()
    setMessageWindowScope(null)
    vi.unstubAllGlobals()
    localStorage.clear()
})

describe('authenticated offline startup', () => {
    it('opens local history with an expired JWT and renews automatically on reconnect', async () => {
        const old = makeAuth(Math.floor(Date.now() / 1000) - 60)
        await rememberOfflineAuth(baseUrl, source.token, old)
        let online = false
        const renewed = makeAuth(Math.floor(Date.now() / 1000) + 3600)
        vi.stubGlobal('fetch', async () => {
            if (!online) throw new TypeError('network unavailable')
            return new Response(JSON.stringify(renewed))
        })
        const { result } = renderHook(() => useAuth(source, baseUrl))
        await waitFor(() => expect(result.current.api).not.toBeNull())
        expect(result.current.user).toEqual(old.user)
        expect(result.current.error).toBeNull()
        expect(result.current.api?.offlineCache?.getStatus()).toBe('offline')
        await act(async () => {
            online = true
            window.dispatchEvent(new Event('online'))
        })
        await waitFor(() => expect(result.current.token).toBe(renewed.token))
        expect(result.current.api?.offlineCache?.getStatus()).toBe('online')
    })

    it('rejects revoked credentials instead of treating HTTP 401 as offline', async () => {
        await rememberOfflineAuth(baseUrl, source.token, makeAuth(Math.floor(Date.now() / 1000) + 3600))
        vi.stubGlobal('fetch', async () => new Response('{}', { status: 401 }))
        const { result } = renderHook(() => useAuth(source, baseUrl))
        await waitFor(() => expect(result.current.error).toContain('401'))
        expect(result.current.api).toBeNull()
        expect(await readOfflineAuth(baseUrl, source.token)).toBeNull()
    })

    it('cannot use another access token or hub to open a remembered login', async () => {
        await rememberOfflineAuth(baseUrl, source.token, makeAuth(Math.floor(Date.now() / 1000) + 3600))
        expect(await readOfflineAuth(baseUrl, 'different-token')).toBeNull()
        expect(await readOfflineAuth('http://other.test', source.token)).toBeNull()
        vi.stubGlobal('fetch', async () => { throw new TypeError('network unavailable') })
        const otherSource = { type: 'accessToken' as const, token: 'different-token' }
        const { result } = renderHook(() => useAuth(otherSource, baseUrl))
        await waitFor(() => expect(result.current.error).toContain('network unavailable'))
        expect(result.current.api).toBeNull()
    })
})
