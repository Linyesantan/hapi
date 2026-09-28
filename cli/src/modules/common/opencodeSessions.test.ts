import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

let root: string
const modulePath = fileURLToPath(new URL('./opencodeSessions.ts', import.meta.url))
function run(code: string) {
    return execFileSync('bun', ['-e', code], { env: { ...process.env, XDG_DATA_HOME: root, HAPI_HOME: join(root, 'hapi') }, encoding: 'utf8' })
}
beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hapi-opencode-history-'))
    mkdirSync(join(root, 'opencode'))
    run(`
        import { Database } from 'bun:sqlite';
        import { join } from 'node:path';
        const db = new Database(join(process.env.XDG_DATA_HOME, 'opencode', 'opencode.db'));
        db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, directory TEXT, time_updated INTEGER, revert TEXT); CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT); CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)');
        db.query('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)').run('native-1', null, '中文会话', '/work', 2000, null);
        db.query('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)').run('child-1', 'native-1', 'child', '/work', 3000, null);
        for (const [id, role, time] of [['m1', 'user', 1000], ['m2', 'assistant', 2000]]) db.query('INSERT INTO message VALUES (?, ?, ?, ?)').run(id, 'native-1', time, JSON.stringify({ role }));
        const parts = [
            ['p1', 'm1', 1000, { type: 'text', text: '中文问题' }],
            ['p2', 'm2', 2000, { type: 'reasoning', text: '思考摘要' }],
            ['p3', 'm2', 2001, { type: 'tool', tool: 'bash', callID: 'call-1', state: { status: 'completed', input: { command: 'pwd' }, output: '/work' } }],
            ['p4', 'm2', 2002, { type: 'text', text: '中文回答' }]
        ];
        for (const [id, message, time, data] of parts) db.query('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run(id, message, 'native-1', time, JSON.stringify(data));
        db.close();
    `)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('OpenCode native history reader', () => {
    it('reads a real SQLite snapshot with Chinese text, Thinking and tools without modifying the database', () => {
        const dbFile = join(root, 'opencode', 'opencode.db')
        const before = readFileSync(dbFile)
        const data = JSON.parse(run(`
            import { listLocalOpencodeSessionSummaries, listLocalOpencodeSessionsWithMessagesByIds } from ${JSON.stringify(modulePath)};
            console.log(JSON.stringify({ summaries: await listLocalOpencodeSessionSummaries(), sessions: await listLocalOpencodeSessionsWithMessagesByIds(new Set(['native-1'])) }));
        `))
        expect(data.summaries).toHaveLength(1)
        expect(data.summaries[0]).toMatchObject({ id: 'native-1', title: '中文会话', lastUserMessage: '中文问题' })
        expect(data.sessions[0].messages.map((message: { content: { role: string; content: { type: string; data?: { type: string } } } }) => message.content.content.data?.type ?? message.content.role))
            .toEqual(['user', 'reasoning', 'tool-call', 'tool-call-result', 'message'])
        expect(readFileSync(dbFile)).toEqual(before)
    })

    it('honors native undo boundaries and selected IDs instead of reopening the agent', () => {
        run(`import { Database } from 'bun:sqlite'; import { join } from 'node:path'; const db = new Database(join(process.env.XDG_DATA_HOME, 'opencode', 'opencode.db')); db.query('UPDATE session SET revert = ? WHERE id = ?').run(JSON.stringify({ messageID: 'm2' }), 'native-1'); db.close();`)
        const sessions = JSON.parse(run(`import { listLocalOpencodeSessionsWithMessagesByIds } from ${JSON.stringify(modulePath)}; console.log(JSON.stringify(await listLocalOpencodeSessionsWithMessagesByIds(new Set(['native-1', "bad'id"]))));`))
        expect(sessions).toHaveLength(1)
        expect(sessions[0].messages).toHaveLength(1)
    })

    it('preserves native file previews through the history RPC schema', () => {
        const sessions = JSON.parse(run(`
            import { Database } from 'bun:sqlite';
            import { createHash } from 'node:crypto';
            import { mkdirSync, writeFileSync } from 'node:fs';
            import { join } from 'node:path';
            import { listLocalOpencodeSessionsWithMessagesByIds } from ${JSON.stringify(modulePath)};
            import { ListOpencodeSessionsRpcResponseSchema } from '@hapi/protocol/apiTypes';
            const key = createHash('sha256').update(['opencode', 'native-1'].join(String.fromCharCode(0))).digest('hex');
            const dir = join(process.env.HAPI_HOME, 'native-terminal-input', key);
            mkdirSync(dir, { recursive: true });
            const text = '请查看附件 /tmp/native-upload/note.txt';
            const attachment = { id: 'file-1', filename: '说明.txt', mimeType: 'text/plain', size: 12,
                path: '/tmp/native-upload/note.txt', previewText: '完整中文内容' };
            writeFileSync(join(dir, '00000000-0000-4000-8000-000000000001.json'), JSON.stringify({
                status: 'confirmed', wireText: text, attachments: [attachment], imagePaths: []
            }));
            const db = new Database(join(process.env.XDG_DATA_HOME, 'opencode', 'opencode.db'));
            db.query('UPDATE part SET data = ? WHERE id = ?').run(JSON.stringify({ type: 'text', text }), 'p1');
            db.close();
            const response = ListOpencodeSessionsRpcResponseSchema.parse({ success: true,
                sessions: await listLocalOpencodeSessionsWithMessagesByIds(new Set(['native-1'])) });
            console.log(JSON.stringify(response.sessions));
        `))
        expect(sessions[0].messages[0].content.content.attachments).toEqual([
            expect.objectContaining({ filename: '说明.txt', previewText: '完整中文内容' })
        ])
    })
})
