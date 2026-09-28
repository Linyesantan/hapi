import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { nativeInputReason, readNativeTerminalSnapshot, type NativeTerminalTarget } from './nativeTerminalAccess'
import { readNativeTerminal, sendNativeTerminalInput, drainNativeTerminalQueue } from './nativeTerminalInput'
import { uploadNativeTerminalFile, deleteNativeTerminalUpload } from './nativeTerminalUploads'
import { controlNativeTerminal } from './nativeTerminalControl'

const roots: string[] = []
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); vi.restoreAllMocks() })
function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'hapi-native-send-'))
    roots.push(root)
    const procRoot = join(root, 'proc'), codexHome = join(root, 'codex'), receiptsDir = join(root, 'receipts')
    const processRoot = join(procRoot, '1234'), sessionId = randomUUID()
    mkdirSync(join(processRoot, 'fd'), { recursive: true })
    mkdirSync(join(codexHome, 'sessions'), { recursive: true })
    const file = join(codexHome, 'sessions', `rollout-${sessionId}.jsonl`)
    writeFileSync(file, '{}\n')
    symlinkSync('/bin/codex', join(processRoot, 'exe'))
    symlinkSync('/work', join(processRoot, 'cwd'))
    symlinkSync('/dev/pts/33', join(processRoot, 'fd/0'))
    symlinkSync(file, join(processRoot, 'fd/7'))
    const fields = Array.from({ length: 25 }, () => '0')
    fields[0] = 'S'; fields[2] = '1234'; fields[5] = '1234'; fields[19] = '123456'
    writeFileSync(join(processRoot, 'stat'), `1234 (codex) ${fields.join(' ')}`)
    writeFileSync(join(processRoot, 'environ'), 'TMUX=/tmp/test-native-socket,99,0\0TMUX_PANE=%7\0TOKEN=secret\0')
    const request = { agent: 'codex' as const, sessionId }
    const raw = '• 工作中\n\n\x1b[1m›\x1b[0m \x1b[2mAsk Codex to do anything\x1b[0m\n\n  gpt test\n'
    let screen = raw
    let mode = '0'
    const run = vi.fn(async (args: string[], _input?: string) => {
        if (args.includes('display-message')) return `%7|/dev/pts/33|80|5|${mode}|2|2|codex|1233|0|Codex\n`
        if (args.includes('capture-pane')) return screen
        if (args.includes('if-shell')) return 'HAPI_INPUT_SENT\n'
        return ''
    })
    const options = { procRoot, codexHome, receiptsDir, run }
    return { request, options, file, processRoot, run, raw, setScreen: (value: string) => { screen = value }, setMode: (value: string) => { mode = value } }
}

describe('向原生终端可靠发送', () => {
    it('Codex 的动态加载标题和仍运行的旧二进制不影响输入绑定', async () => {
        const f = fixture()
        unlinkSync(join(f.processRoot, 'exe'))
        symlinkSync('/bin/codex (deleted)', join(f.processRoot, 'exe'))
        const original = f.run.getMockImplementation()!
        let title = 0
        f.run.mockImplementation(async (args, text) => (await original(args, text)).replace('|Codex\n', `|spinner-${title++}\n`))
        expect((await readNativeTerminalSnapshot(f.request, f.options)).state.input?.available).toBe(true)
    })
    it('识别空输入区，拒绝草稿、选择模式和前台会话变化', async () => {
        const f = fixture()
        expect((await readNativeTerminalSnapshot(f.request, f.options)).state.input?.available).toBe(true)
        f.setScreen(f.raw.replace('\x1b[2mAsk Codex to do anything', '保留我的草稿'))
        expect((await readNativeTerminalSnapshot(f.request, f.options)).state.input?.available).toBe(false)
        f.setScreen(f.raw); f.setMode('1')
        expect((await readNativeTerminalSnapshot(f.request, f.options)).state.input?.reason).toContain('tmux')
        expect(f.run.mock.calls.every(([args]) => !args.includes('send-keys'))).toBe(true)
    })
    it('中文多行文本走独立粘贴缓冲区；重复和并发重试只提交一次', async () => {
        const f = fixture()
        const binding = (await readNativeTerminalSnapshot(f.request, f.options)).state.input!.binding!
        const input = { ...f.request, binding, requestId: randomUUID(), text: '中文第一行\n第二行含 `字符` 和 $(字面内容)' }
        const [a, b] = await Promise.all([sendNativeTerminalInput(input, f.options), sendNativeTerminalInput(input, f.options)])
        expect(a).toMatchObject({ success: true, receipt: { status: 'submitted', text: input.text } })
        expect(b).toEqual(a)
        expect(f.run.mock.calls.filter(([args]) => args.includes('if-shell'))).toHaveLength(1)
        const load = f.run.mock.calls.find(([args]) => args.includes('load-buffer'))!
        expect(load[1]).toBe(input.text)
        expect(load[0].join(' ')).not.toContain(input.text)
        expect(JSON.stringify(a)).not.toContain('test-native-socket')
        const state = await readNativeTerminal(f.request, f.options)
        expect(state.submissions).toHaveLength(1)
        appendFileSync(f.file, JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: input.text } }) + '\n')
        expect((await readNativeTerminal(f.request, f.options)).submissions).toEqual([])
        expect(await sendNativeTerminalInput(input, f.options)).toMatchObject({ receipt: { status: 'confirmed' } })
        expect(f.run.mock.calls.filter(([args]) => args.includes('if-shell'))).toHaveLength(1)
    })
    it('投递超时保存不确定结果，后续调用和重启后的记录不会重发', async () => {
        const f = fixture()
        const binding = (await readNativeTerminalSnapshot(f.request, f.options)).state.input!.binding!
        const original = f.run.getMockImplementation()!
        f.run.mockImplementation(async (args, input) => {
            if (args.includes('if-shell')) throw new Error('timeout')
            return original(args, input)
        })
        const input = { ...f.request, binding, requestId: randomUUID(), text: '不能重复执行' }
        expect(await sendNativeTerminalInput(input, f.options)).toMatchObject({ receipt: { status: 'indeterminate' } })
        expect(await sendNativeTerminalInput(input, { ...f.options })).toMatchObject({ receipt: { status: 'indeterminate' } })
        expect(f.run.mock.calls.filter(([args]) => args.includes('if-shell'))).toHaveLength(1)
        expect(await sendNativeTerminalInput({ ...input, text: '篡改' }, f.options)).toMatchObject({ success: false })
    })
    it('拒绝工作区外、过期绑定、控制字符，保留已有终端草稿', async () => {
        const f = fixture()
        const binding = (await readNativeTerminalSnapshot(f.request, f.options)).state.input!.binding!
        const input = { ...f.request, binding, requestId: randomUUID(), text: '测试' }
        expect(await sendNativeTerminalInput(input, { ...f.options, canRead: () => false })).toMatchObject({ success: false })
        expect(await sendNativeTerminalInput({ ...input, binding: '0'.repeat(64) }, f.options)).toMatchObject({ success: false })
        expect(await sendNativeTerminalInput({ ...input, text: '\x1b[200~' }, f.options)).toMatchObject({ success: false })
        const original = f.run.getMockImplementation()!
        f.run.mockImplementation(async (args, text) => {
            if (args.includes('load-buffer')) f.setScreen(f.raw.replace('Ask Codex to do anything', '刚刚键入的草稿'))
            return original(args, text)
        })
        expect(await sendNativeTerminalInput(input, f.options)).toMatchObject({ success: false })
        expect(f.run.mock.calls.some(([args]) => args.includes('if-shell'))).toBe(false)
        expect(readFileSync(f.file, 'utf8')).toBe('{}\n')
    })
    it('OpenCode 仅在空白输入区启用，菜单和草稿不能当作输入区', () => {
        const target = { agent: 'opencode', mode: '0', inputOff: '0', cursorX: 5, cursorY: 1 } as NativeTerminalTarget
        const raw = '输出\n  ┃                  \n  ┃                  \n  ┃ Build·model      \n  ╹▀▀▀▀▀▀▀▀▀▀\n'
        expect(nativeInputReason(target, raw)).toBeUndefined()
        expect(nativeInputReason(target, raw.replace('  ┃                  ', '  ┃ 已有草稿          '))).toBeDefined()
        expect(nativeInputReason({ ...target, cursorY: 0 }, raw)).toBeDefined()
    })
    it('忙碌时保存可删除队列；删除和重复请求不会向终端发送内容', async () => {
        const f = fixture()
        f.setScreen(f.raw.replace('工作中', 'Working (esc to interrupt)'))
        const binding = (await readNativeTerminalSnapshot(f.request, f.options)).state.input!.binding!
        const input = { ...f.request, binding, requestId: randomUUID(), text: '等待发送', delivery: 'queue' as const }
        expect(await sendNativeTerminalInput(input, f.options)).toMatchObject({ receipt: { status: 'queued' } })
        const action = { ...f.request, binding, requestId: randomUUID(), action: 'cancel' as const, messageId: input.requestId }
        expect(await controlNativeTerminal(action, f.options)).toMatchObject({ status: 'submitted', state: { submissions: [] } })
        expect(await controlNativeTerminal(action, f.options)).toMatchObject({ status: 'submitted' })
        expect(await sendNativeTerminalInput(input, f.options)).toMatchObject({ receipt: { status: 'cancelled' } })
        expect(f.run.mock.calls.some(([args]) => args.includes('load-buffer') || args.includes('if-shell'))).toBe(false)
    })
    it('立即发送只打断一次并优先投递选中的消息；后台队列遵守宵禁', async () => {
        const f = fixture()
        f.setScreen(f.raw.replace('工作中', 'Working (esc to interrupt)'))
        const binding = (await readNativeTerminalSnapshot(f.request, f.options)).state.input!.binding!
        const first = { ...f.request, binding, requestId: randomUUID(), text: '第一条', delivery: 'queue' as const }
        const second = { ...first, requestId: randomUUID(), text: '优先发送第二条' }
        await sendNativeTerminalInput(first, f.options); await sendNativeTerminalInput(second, f.options)
        const original = f.run.getMockImplementation()!
        f.run.mockImplementation(async (args, text) => {
            if (args.some(arg => arg.includes('HAPI_CONTROL_SENT'))) { f.setScreen(f.raw); return 'HAPI_CONTROL_SENT' }
            return original(args, text)
        })
        const action = { ...f.request, binding, requestId: randomUUID(), action: 'send-now' as const, messageId: second.requestId }
        await controlNativeTerminal(action, f.options); await controlNativeTerminal(action, f.options)
        await drainNativeTerminalQueue({ ...f.options, canSend: () => false })
        expect(f.run.mock.calls.filter(([args]) => args.includes('load-buffer'))).toHaveLength(0)
        await drainNativeTerminalQueue(f.options)
        expect(f.run.mock.calls.filter(([args]) => args.some(arg => arg.includes('send-keys') && arg.includes('Escape')))).toHaveLength(1)
        expect(f.run.mock.calls.find(([args]) => args.includes('load-buffer'))?.[1]).toBe(second.text)
        expect((await readNativeTerminal(f.request, f.options)).submissions?.filter(item => item.status === 'queued').map(item => item.text)).toEqual([first.text])
    })
    it('真实落盘的中文附件可投递；队列引用防删除，跨会话和替换文件被拒绝', async () => {
        const f = fixture()
        const content = Buffer.from('附件内容：中文一二三\n完整原文件。')
        const upload = await uploadNativeTerminalFile({ ...f.request, filename: '中文说明.txt', mimeType: 'text/plain', content: content.toString('base64') }, f.options)
        expect(upload.success).toBe(true)
        expect(readFileSync(upload.path!)).toEqual(content)
        f.setScreen(f.raw.replace('工作中', 'Working (esc to interrupt)'))
        const binding = (await readNativeTerminalSnapshot(f.request, f.options)).state.input!.binding!
        const attachment = { id: randomUUID(), filename: '中文说明.txt', size: content.length, mimeType: 'text/plain', path: upload.path! }
        const input = { ...f.request, binding, requestId: randomUUID(), text: '', attachments: [attachment], delivery: 'queue' as const }
        expect(await sendNativeTerminalInput(input, f.options)).toMatchObject({ receipt: { status: 'queued', attachments: [attachment] } })
        expect(await deleteNativeTerminalUpload({ ...f.request, path: upload.path! }, f.options)).toMatchObject({ success: true })
        expect(readFileSync(upload.path!)).toEqual(content)
        f.setScreen(f.raw)
        await drainNativeTerminalQueue(f.options)
        expect(f.run.mock.calls.find(([args]) => args.includes('load-buffer'))?.[1]).toContain(upload.path!)
        const foreign = await sendNativeTerminalInput({ ...input, requestId: randomUUID(), attachments: [{ ...attachment, path: '/etc/passwd' }] }, f.options)
        expect(foreign).toMatchObject({ success: false })
        unlinkSync(upload.path!); symlinkSync(f.file, upload.path!)
        expect(await sendNativeTerminalInput({ ...input, requestId: randomUUID() }, f.options)).toMatchObject({ success: false })
    })
})
