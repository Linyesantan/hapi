import { execFile } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { promisify } from 'node:util'
import { Hono } from 'hono'
import { z } from 'zod'
import { PhoneGatewayCreateRequestSchema, PhoneGatewaySessionSchema } from '@hapi/protocol/apiTypes'
import type { WebAppEnv } from '../middleware/auth'

const execute = promisify(execFile)
const failureSchema = z.object({ ok: z.literal(false), error: z.string(), code: z.literal('gateway_session_ended').optional() })
type Launcher = (command: string, args: string[]) => Promise<{ stdout: string }>

export function phoneGatewayEnabled(command = process.env.HAPI_PHONE_SESSION_COMMAND): boolean {
    return Boolean(command && isAbsolute(command))
}

const launch: Launcher = (command, args) => execute(command, args, {
    timeout: 45_000,
    maxBuffer: 64 * 1024,
    encoding: 'utf8'
})

export function createPhoneGatewayRoutes(
    command = process.env.HAPI_PHONE_SESSION_COMMAND,
    run: Launcher = launch
): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.post('/phone-gateway/sessions', async (c) => {
        if (!command || !phoneGatewayEnabled(command)) {
            return c.json({ error: '此 Hub 未启用手机网关创建器' }, 404)
        }
        // 创建器只连接本机默认命名空间，不能替其他命名空间启动程序。
        if (c.get('namespace') !== 'default') {
            return c.json({ error: '此网关只允许本机所有者创建会话' }, 403)
        }
        const parsed = PhoneGatewayCreateRequestSchema.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) {
            return c.json({ error: '请选择有效的 CLI、目录和创建请求 ID' }, 400)
        }
        const { agent, directory, requestId } = parsed.data
        const args = ['new', '--agent', agent, '--request', requestId]
        if (directory) args.push('--directory', directory)
        try {
            const { stdout } = await run(command, args)
            const session = PhoneGatewaySessionSchema.parse(JSON.parse(stdout))
            return c.json(session)
        } catch (error) {
            // 只显示创建器的结构化错误，不把命令行、私有环境或 stderr 送到浏览器。
            if (error && typeof error === 'object' && 'stdout' in error && typeof error.stdout === 'string') {
                try {
                    const failure = failureSchema.safeParse(JSON.parse(error.stdout))
                    if (failure.success) return c.json({ error: failure.data.error, code: failure.data.code }, 400)
                } catch { /* 超时或非 JSON 输出使用下面的重试提示。 */ }
            }
            return c.json({ error: '暂未确认启动结果，请重试；相同请求会复用已创建的会话。' }, 503)
        }
    })
    return app
}
