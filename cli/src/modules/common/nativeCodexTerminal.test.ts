import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseNativeCodexQueue, readNativeCodexTerminal } from './nativeCodexTerminal'

const sessionId = '01a097e3-aac0-7350-9aad-2f19502ffdfa'
const roots: string[] = []
const screen = `• 正在执行当前任务

• Messages to be submitted after next tool call
  (press esc to interrupt and send immediately)
  ↳ 都显示
  ↳ 不要停，做好为止
    第二行也保留

› Ask Codex to do anything

  gpt-6-astra high · ~`

afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); vi.restoreAllMocks() })

function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'hapi-native-terminal-'))
    roots.push(root)
    const codexHome = join(root, 'codex-home'), procRoot = join(root, 'proc'), processRoot = join(procRoot, '4243')
    mkdirSync(join(codexHome, 'sessions'), { recursive: true })
    mkdirSync(join(processRoot, 'fd'), { recursive: true })
    const file = join(codexHome, 'sessions', `rollout-now-${sessionId}.jsonl`)
    writeFileSync(file, '{}\n')
    symlinkSync('/bin/codex', join(processRoot, 'exe'))
    symlinkSync('/work/project', join(processRoot, 'cwd'))
    symlinkSync('/dev/pts/1', join(processRoot, 'fd', '0'))
    symlinkSync(file, join(processRoot, 'fd', '7'))
    const fields = Array.from({ length: 25 }, () => '0')
    fields[0] = 'S'; fields[1] = '3702'; fields[2] = '3702'; fields[5] = '3702'; fields[19] = '123456'
    writeFileSync(join(processRoot, 'stat'), `4243 (codex) ${fields.join(' ')}`)
    writeFileSync(join(processRoot, 'environ'), 'TMUX=/tmp/tmux-1000/default,3081,0\0TMUX_PANE=%0\0PRIVATE_TOKEN=do-not-expose\0')
    const run = vi.fn(async (args: string[]): Promise<string> => args.includes('display-message') ? '%0|/dev/pts/1|53|45|0\n' : screen)
    return { codexHome, procRoot, processRoot, run }
}

describe('原生 Codex 等待消息', () => {
    it('读取实际 TUI 队列布局，保留中文、多条消息和换行', () => {
        const result = parseNativeCodexQueue(screen)
        expect(result.status).toBe('visible')
        expect(result.messages.map(item => item.text)).toEqual(['都显示', '不要停，做好为止\n第二行也保留'])
        expect(parseNativeCodexQueue(screen).messages).toEqual(result.messages)
    })
    it('支持 tmux -J 合并后的标题帮助行', () => {
        expect(parseNativeCodexQueue(screen.replace('\n  (press', ' (press')).messages).toHaveLength(2)
    })
    it('同时接受工具后和回合后的排队标题，未知格式不会误报空队列', () => {
        expect(parseNativeCodexQueue(screen.replace('after next tool call', 'after the current turn')).messages).toHaveLength(2)
        expect(parseNativeCodexQueue('• Unrecognized queue heading\n  ↳ 尚未提交\n› '))
            .toMatchObject({ status: 'unavailable', messages: [] })
    })
    it('无输入区时不把无法读取当成空队列', () => {
        expect(parseNativeCodexQueue('• Waiting for approval')).toMatchObject({ status: 'unavailable', messages: [] })
        expect(parseNativeCodexQueue('• Working\n\n› ')).toEqual({ status: 'visible', messages: [] })
    })
    it('拒绝把历史工具输出中的队列示例当成当前排队消息', () => {
        expect(parseNativeCodexQueue('• Messages to be submitted after next tool call\n  ↳ old\n• Ran other command\n  result\n› '))
            .toMatchObject({ status: 'unavailable', messages: [] })
    })
    it('精确关联 transcript、进程和 tmux TTY，只调用读取命令且不暴露环境', async () => {
        const options = fixture()
        const result = await readNativeCodexTerminal(sessionId, options)
        expect(result.running).toBe(true)
        expect(result.queue.messages).toHaveLength(2)
        expect(result.terminal).toMatchObject({ columns: 53, rows: 45 })
        expect(options.run.mock.calls.map(([args]) => args[2])).toEqual(['display-message', 'capture-pane'])
        expect(JSON.stringify(result)).not.toContain('PRIVATE_TOKEN')
        expect(JSON.stringify(result)).not.toContain('/tmp/tmux-1000')
    })
    it('workspace 拒绝、另一条 transcript 和非法 ID 不触发终端读取', async () => {
        const options = fixture()
        expect((await readNativeCodexTerminal(sessionId, { ...options, canRead: () => false })).running).toBe(false)
        expect((await readNativeCodexTerminal('01a097e3-aac0-7350-9aad-2f19502fffff', options)).running).toBe(false)
        expect((await readNativeCodexTerminal('%0;send-keys', options)).running).toBe(false)
        expect(options.run).not.toHaveBeenCalled()
    })
    it('拒绝另一窗格、copy mode 及不再由该进程持有的画面', async () => {
        const options = fixture()
        options.run.mockResolvedValueOnce('%0|/dev/pts/99|53|45|0')
        expect((await readNativeCodexTerminal(sessionId, options)).terminal).toBeUndefined()
        options.run.mockResolvedValueOnce('%0|/dev/pts/1|53|45|1')
        expect((await readNativeCodexTerminal(sessionId, options)).terminal).toBeUndefined()
        options.run.mockImplementation(async args => {
            if (args.includes('display-message')) return '%0|/dev/pts/1|53|45|0'
            unlinkSync(join(options.processRoot, 'fd', '7'))
            return screen
        })
        expect((await readNativeCodexTerminal(sessionId, options)).terminal).toBeUndefined()
    })
    it('终端超时只能报告不可读取，不能声称没有等待消息', async () => {
        const options = fixture()
        options.run.mockRejectedValue(new Error('timeout'))
        expect(await readNativeCodexTerminal(sessionId, options)).toMatchObject({ running: true, queue: { status: 'unavailable' } })
    })
    it('同一进程持有多条 transcript 时不把另一条会话的队列混进来', async () => {
        const options = fixture()
        const other = join(options.codexHome, 'sessions', 'rollout-other-01a097e3-aac0-7350-9aad-2f19502fffff.jsonl')
        writeFileSync(other, '{}\n')
        symlinkSync(other, join(options.processRoot, 'fd', '8'))
        const state = await readNativeCodexTerminal(sessionId, options)
        expect(state).toMatchObject({ running: true, queue: { status: 'unavailable', messages: [] } })
        expect(state.terminal).toBeUndefined()
        expect(options.run).not.toHaveBeenCalled()
    })
})
