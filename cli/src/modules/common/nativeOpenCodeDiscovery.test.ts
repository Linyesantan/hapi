import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))

describe('OpenCode 持续自动发现', () => {
    it('新进程、切换会话、重启自动重新匹配，重复标题不冒认', () => {
        const root = mkdtempSync(join(tmpdir(), 'hapi-opencode-discovery-'))
        roots.push(root)
        const module = fileURLToPath(new URL('./nativeTerminalAccess.ts', import.meta.url))
        const output = execFileSync('bun', ['-e', `
            import { Database } from 'bun:sqlite';
            import { mkdirSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
            import { join } from 'node:path';
            import { findRunningOpencodeTargets } from ${JSON.stringify(module)};
            const root = ${JSON.stringify(root)};
            const procRoot = join(root, 'proc'), processRoot = join(procRoot, '9876'), database = join(root, 'opencode.db');
            mkdirSync(join(processRoot, 'fd'), { recursive: true });
            const db = new Database(database);
            db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, directory TEXT)');
            const add = db.query('INSERT INTO session VALUES (?, ?, ?)');
            add.run('ses_A', '新的中文会话', '/work'); add.run('ses_B', '切换后的会话', '/work');
            symlinkSync('/bin/opencode.exe', join(processRoot, 'exe'));
            symlinkSync('/work', join(processRoot, 'cwd'));
            symlinkSync('/dev/pts/39', join(processRoot, 'fd/0'));
            symlinkSync(database, join(processRoot, 'fd/8'));
            const fields = Array.from({ length: 25 }, () => '0'); fields[0]='S'; fields[2]='9876'; fields[5]='9876'; fields[19]='100';
            const writeStat = () => writeFileSync(join(processRoot,'stat'), '9876 (opencode) '+fields.join(' ')); writeStat();
            writeFileSync(join(processRoot,'environ'), 'TMUX=/tmp/isolated-tmux,42,0\\0TMUX_PANE=%19\\0');
            let title = 'OC | 新的中文会话';
            const options = { procRoot, opencodeDatabase: database, run: async args => '%19|/dev/pts/39|80|24|0|5|17|opencode.exe|9876|0|'+title+'\\n' };
            const original = readFileSync(database);
            const first = await findRunningOpencodeTargets(options);
            title = 'OC | 切换后的会话';
            const second = await findRunningOpencodeTargets(options);
            fields[19]='200'; writeStat();
            const restarted = await findRunningOpencodeTargets(options);
            const unchanged = original.equals(readFileSync(database));
            add.run('ses_C', '切换后的会话', '/work');
            const ambiguous = await findRunningOpencodeTargets(options);
            const denied = await findRunningOpencodeTargets({ ...options, canRead: () => false });
            console.log(JSON.stringify({ first: first.map(x=>x.sessionId), second: second.map(x=>x.sessionId), restarted: restarted.map(x=>x.sessionId), generationChanged: second[0].binding !== restarted[0].binding, unchanged, ambiguous: ambiguous.length, denied: denied.length }));
            db.close();
        `], { encoding: 'utf8' })
        expect(JSON.parse(output)).toEqual({ first: ['ses_A'], second: ['ses_B'], restarted: ['ses_B'], generationChanged: true, unchanged: true, ambiguous: 0, denied: 0 })
    })
})
