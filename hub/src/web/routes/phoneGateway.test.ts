import { describe, expect, it, mock } from 'bun:test'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { createAuthMiddleware, type WebAppEnv } from '../middleware/auth'
import { createPhoneGatewayRoutes } from './phoneGateway'

const secret = new TextEncoder().encode('gateway-test-secret')
const requestId = '53714570-5570-4358-9668-ea704c20980c'
const session = { ok: true, agent: 'codex', session_id: 'session-1', tmux_session: 'codex-53714570',
    tmux_socket: 'hapi-phone', active: true, directory: '/tmp/中文 项目' }

async function setup(command = '/desktop/hapi-phone-session', namespace = 'default') {
    const run = mock(async (_command: string, _args: string[]) => ({ stdout: JSON.stringify(session) }))
    const app = new Hono<WebAppEnv>()
    app.use('/api/*', createAuthMiddleware(secret))
    app.route('/api', createPhoneGatewayRoutes(command, run))
    const token = await new SignJWT({ uid: 1, ns: namespace }).setProtectedHeader({ alg: 'HS256' }).sign(secret)
    const send = (body: unknown, authenticated = true) => app.request('/api/phone-gateway/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(authenticated ? { authorization: 'Bearer ' + token } : {}) },
        body: JSON.stringify(body)
    })
    return { send, run }
}

describe('手机网关创建独立 CLI', () => {
    it('只允许认证后的本机所有者使用已配置的创建器', async () => {
        const input = { agent: 'codex', requestId }
        const owner = await setup()
        expect((await owner.send(input, false)).status).toBe(401)
        expect(owner.run).not.toHaveBeenCalled()
        const tenant = await setup('/desktop/hapi-phone-session', 'team')
        expect((await tenant.send(input)).status).toBe(403)
        expect(tenant.run).not.toHaveBeenCalled()
        const disabled = await setup('')
        expect((await disabled.send(input)).status).toBe(404)
        expect(disabled.run).not.toHaveBeenCalled()
    })

    it('保留请求 ID，中文、空格和 shell 符号只作为目录参数传递', async () => {
        const { send, run } = await setup()
        const directory = '/tmp/中文 项目/$(touch nope); `pwd`'
        const input = { agent: 'codex', requestId, directory }
        expect((await send(input)).status).toBe(200)
        expect((await send(input)).status).toBe(200)
        expect(run).toHaveBeenCalledTimes(2)
        expect(run.mock.calls[0]).toEqual(['/desktop/hapi-phone-session', [
            'new', '--agent', 'codex', '--request', requestId, '--directory', directory
        ]])
        expect(run.mock.calls[1]).toEqual(run.mock.calls[0])
    })

    it('拒绝未知程序、无效请求 ID、NUL 和额外的执行参数', async () => {
        const { send, run } = await setup()
        for (const input of [
            { agent: 'shell', requestId },
            { agent: 'pi', requestId: '../../test' },
            { agent: 'pi', requestId, directory: '/tmp/\0bad' },
            { agent: 'pi', requestId, command: 'anything' }
        ]) expect((await send(input)).status).toBe(400)
        expect(run).not.toHaveBeenCalled()
    })

    it('仅返回创建器的结构化错误，超时仍能使用原请求重试', async () => {
        const { send, run } = await setup()
        run.mockRejectedValueOnce(Object.assign(new Error('private stderr'), {
            stdout: JSON.stringify({ ok: false, error: '工作目录不是文件夹' })
        }))
        const input = { agent: 'pi', requestId }
        const invalid = await send(input)
        expect(invalid.status).toBe(400)
        expect(await invalid.json()).toEqual({ error: '工作目录不是文件夹' })
        run.mockRejectedValueOnce(new Error('private stderr'))
        const timeout = await send(input)
        expect(timeout.status).toBe(503)
        expect(await timeout.text()).not.toContain('private stderr')
        expect((await send(input)).status).toBe(200)
    })

    it('区分已结束的启动和临时断线，允许客户端重新新建', async () => {
        const { send, run } = await setup()
        run.mockRejectedValueOnce(Object.assign(new Error('exit'), {
            stdout: JSON.stringify({ ok: false, error: '已结束', code: 'gateway_session_ended' })
        }))
        expect(await (await send({ agent: 'pi', requestId })).json()).toEqual({
            error: '已结束', code: 'gateway_session_ended'
        })
    })
})
