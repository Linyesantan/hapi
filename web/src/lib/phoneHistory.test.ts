import { describe, expect, it } from 'vitest'
import { getHistoryStatus } from './phoneHistory'

describe('native terminal status', () => {
    it('shows recent process evidence separately from gateway connectivity', () => {
        expect(getHistoryStatus({ state: 'running', checkedAt: 1000 }, 2000, true)).toEqual({ running: true, text: '原终端运行中' })
    })
    it('never keeps an offline or expired cached record green', () => {
        expect(getHistoryStatus({ state: 'running', checkedAt: 1000 }, 2000, false)).toEqual({ running: false, text: '缓存记录 · 只读' })
        expect(getHistoryStatus({ state: 'running', checkedAt: 1000 }, 61_000, true).running).toBe(false)
        expect(getHistoryStatus({ state: 'running', checkedAt: 3000 }, 2000, true).running).toBe(false)
        expect(getHistoryStatus(undefined, 2000, true).text).toBe('原终端历史 · 只读')
    })
})
