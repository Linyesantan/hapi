import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { NativeModelRequestSchema, type NativeModelRequest, type NativeModelResponse } from '@hapi/protocol/apiTypes'
import { nativeComposerText, readNativeTerminalSnapshot, runNativeTmux } from './nativeTerminalAccess'
import { saveNativeTerminalRecord, withNativeTerminalLock, type NativeTerminalInputOptions } from './nativeTerminalInput'

const RecordSchema = z.object({
    request: NativeModelRequestSchema,
    cwd: z.string(), file: z.string(),
    status: z.enum(['submitted', 'indeterminate', 'rejected'])
})
const keys = { up: 'Up', down: 'Down', confirm: 'Enter', cancel: 'Escape' } as const

async function act(request: NativeModelRequest, options: NativeTerminalInputOptions): Promise<NativeModelResponse> {
    const key = createHash('sha256').update(`${request.agent}\0${request.sessionId}`).digest('hex')
    const directory = join(options.receiptsDir, key, 'models')
    const path = join(directory, `${request.requestId}.json`)
    let previous: z.infer<typeof RecordSchema> | undefined
    try { previous = RecordSchema.parse(JSON.parse(readFileSync(path, 'utf8'))) }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { success: false, error: '无法核对上次模型操作；请查看原终端，不会重复发送按键。' }
    }
    let snapshot = await readNativeTerminalSnapshot(request, options)
    if (previous) {
        if (JSON.stringify(previous.request) !== JSON.stringify(request)) return { success: false, error: '该操作编号已使用，请刷新模型菜单。' }
        if (options.canRead && !await options.canRead(previous)) return { success: false, error: 'Path is outside workspace roots' }
        return { success: true, requestId: request.requestId, status: previous.status, state: snapshot.state }
    }
    const target = snapshot.target
    if (!target || target.binding !== request.binding) return { success: false, error: '原终端或会话已变化，请刷新后重新打开模型选择。' }
    if (request.action === 'open' && snapshot.state.modelMenu) {
        return { success: true, requestId: request.requestId, status: 'submitted', state: snapshot.state }
    }
    if (request.action === 'open' ? !snapshot.state.input?.available : !snapshot.state.modelMenu || snapshot.state.modelMenu.fingerprint !== request.fingerprint) {
        return { success: false, error: request.action === 'open'
            ? snapshot.state.input?.reason ?? '请先处理原终端草稿或菜单。'
            : '模型菜单已变化，请根据刷新后的菜单重新选择。' }
    }
    // The second read protects against a local user changing the terminal while
    // the browser is open. Only these fixed menu keys can ever reach tmux.
    const expected = snapshot.state.modelMenu?.fingerprint
    snapshot = await readNativeTerminalSnapshot(request, options)
    if (!snapshot.target || snapshot.target.binding !== target.binding
        || (request.action === 'open' ? !snapshot.state.input?.available : snapshot.state.modelMenu?.fingerprint !== expected)) {
        return { success: false, error: '原终端状态已变化，未发送模型操作。' }
    }
    const record: z.infer<typeof RecordSchema> = { request, cwd: target.cwd, file: target.file, status: 'indeterminate' }
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    saveNativeTerminalRecord(path, record, true)
    const checks = [
        `#{==:#{pane_id},${target.pane}}`, `#{==:#{pane_tty},${target.tty}}`,
        `#{==:#{pane_pid},${target.panePid}}`, `#{==:#{pane_current_command},${target.command}}`,
        '#{==:#{pane_in_mode},0}', '#{==:#{pane_input_off},0}'
    ]
    const condition = checks.reduce((left, right) => `#{&&:${left},${right}}`)
    // /model is typed as a TUI command, never bracket-pasted as chat content.
    const command = request.action === 'open'
        ? `send-keys -t ${target.pane} -l ${request.agent === 'opencode' ? '/models' : '/model'} ; send-keys -t ${target.pane} Enter`
        : `send-keys -t ${target.pane} ${keys[request.action]}`
    try {
        const run = options.run ?? runNativeTmux
        const sendCommand = (command: string) => run(['-S', target.socket, 'if-shell', '-F', '-t', target.pane,
            condition, `${command} ; display-message -p HAPI_MODEL_SENT`, 'display-message -p HAPI_MODEL_REJECTED'])
        const rememberResult = (result: string) => {
            if (result.trim() === 'HAPI_MODEL_SENT') record.status = 'submitted'
            else if (result.trim() === 'HAPI_MODEL_REJECTED') record.status = 'rejected'
        }
        if (request.action === 'open' && request.agent === 'opencode') {
            // OpenCode updates slash completion asynchronously. Enter in the
            // same tmux command can arrive before /models has reached the TUI.
            const typed = await sendCommand(`send-keys -t ${target.pane} -l /models`)
            if (typed.trim() === 'HAPI_MODEL_REJECTED') record.status = 'rejected'
            else if (typed.trim() === 'HAPI_MODEL_SENT') {
                let visible = false
                for (let attempt = 0; attempt < 25; attempt++) {
                    snapshot = await readNativeTerminalSnapshot(request, options)
                    if (!snapshot.target || snapshot.target.binding !== target.binding) break
                    if (snapshot.state.modelMenu) { record.status = 'submitted'; break }
                    const matches = nativeComposerText(snapshot.target, snapshot.raw) === '/models'
                    if (matches && visible) {
                        rememberResult(await sendCommand(`send-keys -t ${target.pane} Enter`))
                        break
                    }
                    visible = matches
                    await new Promise(resolve => setTimeout(resolve, 60))
                }
            }
        } else rememberResult(await sendCommand(command))
        saveNativeTerminalRecord(path, record)
    } catch { /* The durable indeterminate record makes retries read-only. */ }
    // Wait for a painted menu (or for the menu to close), not just tmux's ack.
    for (let attempt = 0; attempt < 12; attempt++) {
        snapshot = await readNativeTerminalSnapshot(request, options)
        if (snapshot.state.modelMenu?.fingerprint !== expected || request.action !== 'open' && snapshot.state.input?.available) break
        await new Promise(resolve => setTimeout(resolve, 60))
    }
    return { success: true, requestId: request.requestId, status: record.status, state: snapshot.state }
}

export async function controlNativeModelMenu(input: NativeModelRequest, options: NativeTerminalInputOptions): Promise<NativeModelResponse> {
    const parsed = NativeModelRequestSchema.safeParse(input)
    if (!parsed.success) return { success: false, error: '无效的模型菜单操作。' }
    return withNativeTerminalLock(parsed.data, options, async () => {
        try { return await act(parsed.data, options) }
        catch { return { success: false, error: '模型操作结果暂时无法确认；使用同一编号重试只核对结果，不会重复操作。' } }
    })
}
