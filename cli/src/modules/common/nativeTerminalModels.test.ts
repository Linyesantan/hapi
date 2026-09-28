import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as access from './nativeTerminalAccess'
import { parseNativeModelMenu } from './nativeTerminalMenu'
import { controlNativeModelMenu } from './nativeTerminalModels'
import type { NativeCodexTerminalState, NativeTerminalRequest } from '@hapi/protocol/apiTypes'

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })) })
const modelScreen = '\x1b[1mSelect Model and Effort\x1b[0m\n\x1b[36m› 1. gpt-test\x1b[0m\n  2. gpt-other\n  enter to confirm · esc to go back\n'
const effortScreen = '\x1b[1mSelect Reasoning Level for gpt-test\x1b[0m\n› 1. Medium\n  2. High\n  enter to confirm · esc to go back\n'
function fixture(agent: NativeTerminalRequest['agent'] = 'codex') {
    const receiptsDir = mkdtempSync(join(tmpdir(), 'hapi-model-test-')); roots.push(receiptsDir)
    const request = { agent, sessionId: agent === 'codex' ? crypto.randomUUID() : 'ses_TestMenu' }
    const binding = 'a'.repeat(64)
    const target = { binding, agent, sessionId: request.sessionId, socket: '/tmp/test-model', pane: '%7',
        tty: '/dev/pts/33', command: agent, panePid: '1234', cwd: '/work', file: '/work/transcript' } as access.NativeTerminalTarget
    let current: NativeCodexTerminalState = { sessionId: request.sessionId, checkedAt: Date.now(), running: true,
        input: { available: true, binding }, queue: { status: 'visible', messages: [] } }
    const snapshot = vi.spyOn(access, 'readNativeTerminalSnapshot').mockImplementation(async () => ({ state: current, target, raw: '' }))
    const setMenu = (raw: string) => { current = { ...current, input: { available: false, binding }, modelMenu: parseNativeModelMenu(agent, raw, 80) } }
    const run = vi.fn(async () => { setMenu(agent === 'codex' ? modelScreen : '\x1b[1mSelect model\x1b[0m       esc\n  gpt-test\n'); return 'HAPI_MODEL_SENT\n' })
    const options = { receiptsDir, run }
    return { request, binding, target, options, snapshot, run, setMenu, state: () => current,
        open: { ...request, binding, requestId: crypto.randomUUID(), action: 'open' as const } }
}

describe('原终端模型菜单', () => {
    it('识别实际模型与强度标题，保留高亮，拒绝聊天中的命令说明和未知菜单', () => {
        expect(parseNativeModelMenu('codex', modelScreen, 80)).toMatchObject({ kind: 'model', title: 'Select Model and Effort' })
        expect(parseNativeModelMenu('codex', effortScreen, 80)?.kind).toBe('effort')
        expect(parseNativeModelMenu('opencode', '\x1b[1mSelect variant\x1b[0m       esc\n  default\n', 80)?.kind).toBe('effort')
        expect(parseNativeModelMenu('codex', modelScreen.replace('Select Model and Effort', '• Select Model and Effort'), 80)).toBeUndefined()
        expect(parseNativeModelMenu('codex', modelScreen.replace('Select Model and Effort', 'Approve command'), 80)).toBeUndefined()
        expect(parseNativeModelMenu('codex', modelScreen, 80)?.fingerprint).not.toBe(parseNativeModelMenu('codex', modelScreen.replace('[36m', '[32m'), 80)?.fingerprint)
    })
    it.each(['codex', 'opencode'] as const)('%s 打开自己的菜单；并发及断线重试不重复按键、不写入聊天队列', async agent => {
        const f = fixture(agent)
        const [first, retry] = await Promise.all([controlNativeModelMenu(f.open, f.options), controlNativeModelMenu(f.open, f.options)])
        expect(first).toMatchObject({ success: true, status: 'submitted', state: { modelMenu: { kind: 'model' } } })
        expect(retry).toEqual(first)
        expect(f.run).toHaveBeenCalledTimes(1)
        const args = (f.run.mock.calls[0] as unknown as [string[]])[0].join(' ')
        expect(args).toContain(agent === 'opencode' ? '-l /models' : '-l /model')
        expect(args).not.toContain('paste-buffer')
        expect(await controlNativeModelMenu({ ...f.open, action: 'cancel', fingerprint: '0'.repeat(64) }, f.options)).toMatchObject({ success: false })
    })
    it('菜单变化、草稿、错误绑定、宵禁和非法按键均不能投递', async () => {
        const f = fixture()
        expect(await controlNativeModelMenu(f.open, { ...f.options, canSend: () => false })).toMatchObject({ success: false })
        expect(await controlNativeModelMenu({ ...f.open, binding: 'b'.repeat(64) }, f.options)).toMatchObject({ success: false })
        expect(await controlNativeModelMenu({ ...f.open, action: 'C-c' as never }, f.options)).toMatchObject({ success: false })
        f.state().input!.available = false
        expect(await controlNativeModelMenu(f.open, f.options)).toMatchObject({ success: false })
        f.setMenu(modelScreen)
        const action = { ...f.open, action: 'confirm' as const, fingerprint: f.state().modelMenu!.fingerprint }
        f.snapshot.mockImplementationOnce(async () => {
            const old = f.state(); f.setMenu(effortScreen)
            return { state: old, target: f.target, raw: '' }
        })
        expect(await controlNativeModelMenu(action, f.options)).toMatchObject({ success: false })
        expect(f.run).not.toHaveBeenCalled()
    })
    it('按键超时持久化待核对结果；重启或重试只读取同一记录', async () => {
        const f = fixture()
        f.setMenu(modelScreen)
        f.run.mockImplementation(async () => { f.setMenu(effortScreen); throw new Error('timeout') })
        const action = { ...f.open, action: 'confirm' as const, fingerprint: f.state().modelMenu!.fingerprint }
        const first = await controlNativeModelMenu(action, f.options)
        expect(first).toMatchObject({ status: 'indeterminate', state: { modelMenu: { kind: 'effort' } } })
        expect(await controlNativeModelMenu(action, { ...f.options })).toEqual(first)
        expect(f.run).toHaveBeenCalledTimes(1)
        expect(await controlNativeModelMenu(action, { ...f.options, canRead: () => false })).toMatchObject({ success: false })
    })
    it('OpenCode 等命令补全画面稳定后再按 Enter，避免停在 /models 补全层', async () => {
        const f = fixture('opencode')
        let typed = false
        const completion = 'Switch model /models\n ┃\n ┃ /models\n ┃\n ┃ Build · gpt-test\n ╹▀▀▀▀▀▀▀▀'
        f.target.cursorY = 2
        f.snapshot.mockImplementation(async () => ({ state: f.state(), target: f.target, raw: typed ? completion : '' }))
        const run = vi.fn(async (args: string[]) => {
            const command = args.join(' ')
            if (command.includes('-l /models')) {
                expect(command).not.toContain(' Enter')
                typed = true
            } else if (command.includes(' Enter')) {
                expect(typed).toBe(true)
                f.setMenu('\x1b[1mSelect model\x1b[0m       esc\n  gpt-test\n')
            }
            return 'HAPI_MODEL_SENT\n'
        })
        const options = { ...f.options, run }
        const result = await controlNativeModelMenu(f.open, options)
        expect(result).toMatchObject({ success: true, status: 'submitted', state: { modelMenu: { kind: 'model' } } })
        expect(run).toHaveBeenCalledTimes(2)
        expect(await controlNativeModelMenu(f.open, options)).toEqual(result)
        expect(run).toHaveBeenCalledTimes(2)
    })
})
