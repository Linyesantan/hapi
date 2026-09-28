import { isAbsolute } from 'node:path'
import { getPhoneCurfew } from '@hapi/protocol/phoneCurfew'
import type { MiddlewareHandler } from 'hono'

export function phoneCurfewState(now = Date.now()) {
    const enabled = Boolean(process.env.HAPI_PHONE_SESSION_COMMAND && isAbsolute(process.env.HAPI_PHONE_SESSION_COMMAND))
    const state = getPhoneCurfew(now)
    return { ...state, enabled, restricted: enabled && state.restricted }
}

export function phoneCurfewMiddleware(state = phoneCurfewState): MiddlewareHandler {
    return async (c, next) => {
        const access = state()
        if (access.restricted) {
            c.header('Retry-After', String(Math.max(1, Math.ceil((access.nextChangeAt - Date.now()) / 1000))))
            return c.json({ error: access.message, code: 'ssh_curfew', nextChangeAt: access.nextChangeAt }, 423)
        }
        return next()
    }
}
