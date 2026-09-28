import { Hono } from 'hono'
import net from 'node:net'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { WebAppEnv } from '../middleware/auth'

const DSH_WEB_PORT = 3080
const DSH_BIN = join(process.env.HOME ?? '', '.local/node/bin/dsh')
const SPAWN_TIMEOUT_MS = 20000

type DshWebState = { pid: number, token: string }
type DshWebStatus = { running: boolean, url: string | null }

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

function probePort(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = net.connect({ host, port })
        const finish = (ok: boolean) => {
            socket.destroy()
            resolve(ok)
        }
        socket.setTimeout(timeoutMs)
        socket.once('connect', () => finish(true))
        socket.once('timeout', () => finish(false))
        socket.once('error', () => finish(false))
    })
}

function findLanIp(): string | null {
    const preferred: string[] = []
    const others: string[] = []
    for (const addrs of Object.values(os.networkInterfaces())) {
        for (const addr of addrs ?? []) {
            if (addr.family !== 'IPv4' || addr.internal) continue
            if (addr.address.startsWith('192.168.')) preferred.push(addr.address)
            else others.push(addr.address)
        }
    }
    return preferred[0] ?? others[0] ?? null
}

function urlFor(token: string): string | null {
    const ip = findLanIp()
    return ip === null ? null : `http://${ip}:${DSH_WEB_PORT}/?token=${encodeURIComponent(token)}`
}

function stateFile(dataDir: string): string {
    return join(dataDir, 'dsh-web.json')
}

async function readState(dataDir: string): Promise<DshWebState | null> {
    try {
        const raw = JSON.parse(await readFile(stateFile(dataDir), 'utf8')) as DshWebState
        if (typeof raw.pid === 'number' && typeof raw.token === 'string') return raw
        return null
    } catch {
        return null
    }
}

async function writeState(dataDir: string, state: DshWebState): Promise<void> {
    await mkdir(dataDir, { recursive: true })
    await writeFile(stateFile(dataDir), JSON.stringify(state, null, 4))
}

async function tokenValid(token: string): Promise<boolean> {
    try {
        const res = await fetch(`http://127.0.0.1:${DSH_WEB_PORT}/?token=${encodeURIComponent(token)}`, {
            signal: AbortSignal.timeout(3000),
            redirect: 'manual'
        })
        // 303 = token 已换取 cookie；200 = 已有有效 cookie；401/其他 = 无效
        return res.status === 303 || res.status === 200
    } catch {
        return false
    }
}

function spawnDshWeb(dataDir: string): Promise<boolean> {
    return new Promise((resolve) => {
        let token: string | null = null
        let buffer = ''
        let settled = false
        const finish = (ok: boolean) => {
            if (settled) return
            settled = true
            resolve(ok)
        }
        try {
            const child = spawn(DSH_BIN, ['web', '--no-open'], {
                stdio: ['ignore', 'pipe', 'pipe'],
                detached: true
            })
            child.stdout?.on('data', (chunk: Buffer) => {
                buffer += String(chunk)
                const match = /token=([A-Za-z0-9_-]+)/.exec(buffer)
                if (match) token = match[1]
            })
            child.on('error', () => finish(false))
            child.unref()
            void (async () => {
                const deadline = Date.now() + SPAWN_TIMEOUT_MS
                while (Date.now() < deadline) {
                    if (token !== null && await probePort('127.0.0.1', DSH_WEB_PORT, 400)) {
                        await writeState(dataDir, { pid: child.pid ?? -1, token })
                        finish(true)
                        return
                    }
                    await sleep(400)
                }
                finish(false)
            })()
        } catch {
            finish(false)
        }
    })
}

async function ensureRunning(dataDir: string): Promise<DshWebStatus> {
    if (await probePort('127.0.0.1', DSH_WEB_PORT)) {
        const state = await readState(dataDir)
        if (state && await tokenValid(state.token)) {
            return { running: true, url: urlFor(state.token) }
        }
        if (state) {
            try {
                process.kill(state.pid, 'SIGTERM')
            } catch {}
            const deadline = Date.now() + 5000
            while (Date.now() < deadline && await probePort('127.0.0.1', DSH_WEB_PORT, 300)) {
                await sleep(300)
            }
        }
        if (!await spawnDshWeb(dataDir)) {
            return { running: await probePort('127.0.0.1', DSH_WEB_PORT), url: null }
        }
        const next = await readState(dataDir)
        return { running: true, url: next ? urlFor(next.token) : null }
    }
    if (!await spawnDshWeb(dataDir)) {
        return { running: false, url: null }
    }
    const next = await readState(dataDir)
    return { running: true, url: next ? urlFor(next.token) : null }
}

let inflight: Promise<DshWebStatus> | null = null

function ensureRunningOnce(dataDir: string): Promise<DshWebStatus> {
    inflight ??= ensureRunning(dataDir).finally(() => {
        inflight = null
    })
    return inflight
}

async function quickStatus(dataDir: string): Promise<DshWebStatus> {
    if (await probePort('127.0.0.1', DSH_WEB_PORT)) {
        const state = await readState(dataDir)
        if (state && await tokenValid(state.token)) {
            return { running: true, url: urlFor(state.token) }
        }
        return { running: true, url: null }
    }
    void ensureRunningOnce(dataDir)
    return { running: false, url: null }
}

export function createDshWebRoutes(dataDir: string): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/dsh-web/status', async (c) => {
        c.header('Cache-Control', 'no-store')
        return c.json(await quickStatus(dataDir))
    })

    app.post('/dsh-web/open', async (c) => {
        c.header('Cache-Control', 'no-store')
        return c.json(await ensureRunningOnce(dataDir))
    })

    return app
}
