import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NativeTerminalControlRequestSchema, type NativeTerminalControlRequest, type NativeTerminalControlResponse } from '@hapi/protocol/apiTypes'
import { nativeComposerText, nativeTmuxCondition, readNativeTerminalSnapshot, runNativeTmux } from './nativeTerminalAccess'
import { deliverNativeTerminalRecord, nativeTerminalDirectory, readNativeTerminal, readNativeTerminalRecord,
    saveNativeTerminalRecord, withNativeTerminalLock, type NativeTerminalInputOptions } from './nativeTerminalInput'

export async function controlNativeTerminal(input: NativeTerminalControlRequest, options: NativeTerminalInputOptions): Promise<NativeTerminalControlResponse> {
    const parsed = NativeTerminalControlRequestSchema.safeParse(input)
    if (!parsed.success) return { success: false, error: '无效的终端操作。' }
    const request = parsed.data
    return withNativeTerminalLock(request, options, async () => {
        const directory = nativeTerminalDirectory(request, options)
        const actionPath = join(directory, 'controls', `${request.requestId}.json`)
        type ActionRecord = { request: NativeTerminalControlRequest; status: 'submitted' | 'indeterminate' | 'rejected'; cwd: string; file: string }
        try {
            let previous: ActionRecord | undefined
            try { previous = JSON.parse(readFileSync(actionPath, 'utf8')) as ActionRecord }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
            if (previous) {
                if (JSON.stringify(previous.request) !== JSON.stringify(request)) return { success: false, error: '操作编号已经使用，请刷新。' }
                if (options.canRead && !await options.canRead(previous)) return { success: false, error: 'Path is outside workspace roots' }
                return { success: true, requestId: request.requestId, status: previous.status, state: await readNativeTerminal(request, options) }
            }
            const snapshot = await readNativeTerminalSnapshot(request, options)
            const target = snapshot.target
            if (!target || target.binding !== request.binding) return { success: false, error: '原终端状态已变化，请刷新后操作。' }
            const messagePath = request.messageId ? join(directory, `${request.messageId}.json`) : null
            const message = messagePath ? readNativeTerminalRecord(messagePath) : undefined
            if (request.action !== 'interrupt' && message?.status !== 'queued') return { success: false, error: '这条消息已送入终端或已删除，请刷新队列。' }
            if (request.action !== 'cancel' && (snapshot.state.modelMenu || nativeComposerText(target, snapshot.raw) === null)) {
                return { success: false, error: '原终端正在显示菜单；请先返回会话，再停止或发送。' }
            }
            const action: ActionRecord = { request, status: 'indeterminate', cwd: target.cwd, file: target.file }
            mkdirSync(join(directory, 'controls'), { recursive: true, mode: 0o700 })
            saveNativeTerminalRecord(actionPath, action, true)
            if (request.action === 'cancel' && message && messagePath) {
                message.status = 'cancelled'; message.note = '已从等待队列删除，未发送给终端。'
                saveNativeTerminalRecord(messagePath, message)
            } else {
                if (message && messagePath) {
                    message.immediate = true
                    message.note = '已选择立即发送，正在等待当前回复停止。'
                    saveNativeTerminalRecord(messagePath, message)
                }
                if (snapshot.state.busy) {
                    const run = options.run ?? runNativeTmux
                    const sendEscape = async () => {
                        const fresh = await readNativeTerminalSnapshot(request, options)
                        if (!fresh.target || fresh.target.binding !== target.binding || fresh.state.modelMenu
                            || nativeComposerText(fresh.target, fresh.raw) === null) throw new Error('Terminal changed')
                        const result = await run(['-S', target.socket, 'if-shell', '-F', '-t', target.pane, nativeTmuxCondition(fresh.target),
                            `send-keys -t ${target.pane} Escape ; display-message -p HAPI_CONTROL_SENT`, 'display-message -p HAPI_CONTROL_REJECTED'])
                        if (result.trim() !== 'HAPI_CONTROL_SENT') throw new Error('Interrupt not confirmed')
                    }
                    await sendEscape()
                    // OpenCode explicitly asks for a second Esc within 5 s.
                    if (request.agent === 'opencode') {
                        await new Promise(resolve => setTimeout(resolve, 120))
                        await sendEscape()
                    }
                } else if (message && snapshot.state.input?.available) {
                    const result = await deliverNativeTerminalRecord(message, options)
                    if (!result.success || result.receipt.status === 'indeterminate') throw new Error('Delivery not confirmed')
                }
            }
            action.status = 'submitted'
            saveNativeTerminalRecord(actionPath, action)
            return { success: true, requestId: request.requestId, status: action.status, state: await readNativeTerminal(request, options) }
        } catch {
            return { success: true, requestId: request.requestId, status: 'indeterminate', state: await readNativeTerminal(request, options) }
        }
    })
}
