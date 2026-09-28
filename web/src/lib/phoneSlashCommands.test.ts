import { describe, expect, it } from 'vitest'
import { getBuiltinSlashCommands } from '@hapi/protocol/slashCommands'
import { getPhoneSlashCommands, PHONE_CLIS, resolvePhoneSlashCommand } from './phoneSlashCommands'

describe('统一的手机网关命令', () => {
    it('三种 CLI 已支持的命令和网关功能均可发现，名字不重复', () => {
        for (const active of PHONE_CLIS) {
            const commands = getPhoneSlashCommands(active)
            const names = commands.map(command => command.name)
            for (const cli of PHONE_CLIS) {
                for (const command of getBuiltinSlashCommands(cli)) expect(names).toContain(command.name)
            }
            for (const name of ['new', 'sessions', 'resume', 'diff', 'files', 'fork', 'rename', 'skills', 'fast']) expect(names).toContain(name)
            expect(new Set(names).size).toBe(names.length)
        }
    })

    it('独有、共有、原终端命令均保留适用说明', () => {
        const commands = getPhoneSlashCommands('pi')
        expect(commands.find(command => command.name === 'fast')?.description).toContain('Codex')
        expect(commands.find(command => command.name === 'model')?.description).toMatch(/Codex.*OpenCode.*Pi/)
        expect(commands.find(command => command.name === 'tree')?.description).toMatch(/Pi.*原终端/)
        expect(commands.find(command => command.name === 'reload')?.description).toContain('Pi')
        expect(commands.find(command => command.name === 'unshare')?.description).toContain('OpenCode')
        expect(commands.find(command => command.name === 'mcp')?.description).toContain('Codex')
    })

    it('动态命令、同名项目覆盖和新版本内置命令不会丢失', () => {
        const commands = getPhoneSlashCommands('pi', [
            { name: 'mcp', source: 'plugin', description: '扩展测试' },
            { name: 'compact', source: 'project', content: '自定义压缩' },
            { name: 'future-native', source: 'builtin', description: '版本新增' },
        ])
        expect(commands.find(command => command.name === 'mcp')?.description).toContain('Pi · 扩展命令')
        expect(commands.find(command => command.name === 'compact')?.content).toBe('自定义压缩')
        expect(commands.find(command => command.name === 'future-native')).toBeDefined()
        expect(resolvePhoneSlashCommand('/mcp', 'pi', commands).kind).toBe('passthrough')
        expect(resolvePhoneSlashCommand('/compact 参数', 'pi', commands).kind).toBe('passthrough')
    })

    it('不适用当前 CLI 的命令以及原终端命令不会透传给模型', () => {
        expect(resolvePhoneSlashCommand('/goal 测试目标', 'pi', []).kind).toBe('notice')
        expect(resolvePhoneSlashCommand('/fast on', 'opencode', []).kind).toBe('notice')
        expect(resolvePhoneSlashCommand('/tree', 'pi', []).kind).toBe('notice')
        expect(resolvePhoneSlashCommand('/mcp', 'codex', []).kind).toBe('notice')
        expect(resolvePhoneSlashCommand('/agent', 'codex', [], true).kind).toBe('notice')
        expect(resolvePhoneSlashCommand('/fast status', 'codex', []).kind).toBe('passthrough')
        expect(resolvePhoneSlashCommand('/permissions yolo', 'opencode', []).kind).toBe('passthrough')
    })

    it('网关命令分派、别名转换和普通文本保持正确', () => {
        expect(resolvePhoneSlashCommand('/new', 'codex', [])).toMatchObject({ kind: 'gateway', action: 'new' })
        expect(resolvePhoneSlashCommand('/RESUME', 'pi', [])).toMatchObject({ kind: 'gateway', action: 'sessions' })
        expect(resolvePhoneSlashCommand('/rename 中文名称', 'pi', [])).toMatchObject({ kind: 'gateway', action: 'rename', args: '中文名称' })
        expect(resolvePhoneSlashCommand('/summarize', 'opencode', [])).toEqual({ kind: 'passthrough', text: '/compact' })
        expect(resolvePhoneSlashCommand('/tmp/file.txt', 'codex', []).kind).toBe('passthrough')
        expect(resolvePhoneSlashCommand('请查看 /diff', 'codex', []).kind).toBe('passthrough')
    })
})
