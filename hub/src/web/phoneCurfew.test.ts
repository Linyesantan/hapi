import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { getPhoneCurfew } from '@hapi/protocol/phoneCurfew'
import { phoneCurfewMiddleware } from './phoneCurfew'

describe('HAPI 遵守 SSH 宵禁', () => {
    it.each([
        ['2026-09-14T00:29:59+08:00', false], ['2026-09-14T00:30:00+08:00', true],
        ['2026-09-15T05:59:59+08:00', true], ['2026-09-15T06:00:00+08:00', false],
        ['2026-09-18T01:00:00+08:00', true], ['2026-09-19T01:00:00+08:00', false],
        ['2026-09-20T01:00:00+08:00', false], ['2026-09-14T16:30:00Z', true]
    ])('北京时间边界 %s → %s', (time, restricted) => {
        const now = Date.parse(String(time))
        const result = getPhoneCurfew(now)
        expect(result.restricted).toBe(restricted)
        expect(result.nextChangeAt).toBeGreaterThan(now)
        expect(getPhoneCurfew(result.nextChangeAt).restricted).toBe(!restricted)
    })
    it('同时拒绝新登录、读取、发送、创建和 SSE，循环地址不能豁免手机转发', async () => {
        const app = new Hono()
        let called = false
        app.use('/api/*', phoneCurfewMiddleware(() => ({ ...getPhoneCurfew(Date.parse('2026-09-15T01:00:00+08:00')), enabled: true })))
        app.all('/api/*', c => { called = true; return c.json({ ok: true }) })
        for (const path of ['auth', 'sessions', 'sessions/one/messages', 'phone-gateway/sessions', 'phone-gateway/sessions/one/input', 'events']) {
            const response = await app.request(`http://127.0.0.1/api/${path}`, { method: path === 'events' ? 'GET' : 'POST', headers: { 'x-forwarded-for': '127.0.0.1' } })
            expect(response.status).toBe(423)
            expect((await response.json() as { code: string }).code).toBe('ssh_curfew')
        }
        expect(called).toBe(false)
    })
    it('06:00 自动恢复访问，不改动执行任务和 CLI 通道', async () => {
        const app = new Hono()
        app.use('/api/*', phoneCurfewMiddleware(() => ({ ...getPhoneCurfew(Date.parse('2026-09-15T06:00:00+08:00')), enabled: true })))
        app.get('/api/sessions', c => c.json({ ok: true }))
        app.post('/cli/alive', c => c.json({ ok: true }))
        expect((await app.request('/api/sessions')).status).toBe(200)
        expect((await app.request('/cli/alive', { method: 'POST' })).status).toBe(200)
    })
})
