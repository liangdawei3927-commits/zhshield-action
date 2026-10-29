import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ToolScanOptions } from '@zh/shared';
import { SemgrepRuleWriter, removeInlineRuleFile } from '../adapters/semgrep-rule-writer';

/**
 * 内联规则临时文件的位置约束（2026-09-17 R9 修复）。
 *
 * 旧行为把 rules 写成 `<被测项目>/.semgrep/inline-<ts>.yml` 且从不清理，
 * 实测在 fixture 上残留 5 个：既污染用户仓库（会出现在 git status），
 * 又因同源内容互相重复逼得 jscpd 适配器加目录排除来躲误报。
 * 新约定：写在 os.tmpdir() 下的一次性目录，扫描结束由调用方清理。
 */

const tempDirs: string[] = [];

function makeProjectDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'semgrep-writer-'));
  tempDirs.push(dir);
  return dir;
}

function optionsWithRules(projectPath: string): ToolScanOptions {
  return {
    projectPath,
    config: {
      rules: [{ id: 'no-http', severity: 'warning', pattern: 'http.get(...)', message: 'No HTTP' }],
    },
  } as unknown as ToolScanOptions;
}

afterEach(() => {
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('SemgrepRuleWriter — 内联规则写在临时目录，不落被测项目', () => {
  it('规则文件落在 os.tmpdir() 下的一次性目录，并返回绝对路径', async () => {
    const projectDir = makeProjectDir();
    const writer = new SemgrepRuleWriter();

    const rulePath = await writer.writeInlineRuleConfig(optionsWithRules(projectDir));
    expect(rulePath).toBeTruthy();
    const p = rulePath as string;
    tempDirs.push(path.dirname(p));

    expect(path.isAbsolute(p)).toBe(true);
    expect(path.dirname(p).startsWith(os.tmpdir())).toBe(true);
    expect(path.basename(path.dirname(p))).toContain('zhshield-semgrep-');
    expect(fs.existsSync(p)).toBe(true);
    expect(fs.readFileSync(p, 'utf-8')).toContain('no-http');
  });

  it('不会在被测项目里创建 .semgrep 目录', async () => {
    const projectDir = makeProjectDir();
    const writer = new SemgrepRuleWriter();

    const rulePath = await writer.writeInlineRuleConfig(optionsWithRules(projectDir));
    if (rulePath) tempDirs.push(path.dirname(rulePath));

    expect(fs.existsSync(path.join(projectDir, '.semgrep'))).toBe(false);
    expect(fs.readdirSync(projectDir)).toEqual([]);
  });

  it('无内联规则时返回 null（不产生临时文件）', async () => {
    const projectDir = makeProjectDir();
    const writer = new SemgrepRuleWriter();

    const rulePath = await writer.writeInlineRuleConfig({ projectPath: projectDir } as ToolScanOptions);
    expect(rulePath).toBeNull();
  });

  it('removeInlineRuleFile 删掉整个一次性目录，且对 null/不存在路径安全', async () => {
    const projectDir = makeProjectDir();
    const writer = new SemgrepRuleWriter();
    const rulePath = await writer.writeInlineRuleConfig(optionsWithRules(projectDir));
    const dir = path.dirname(rulePath as string);

    await removeInlineRuleFile(rulePath);
    expect(fs.existsSync(dir)).toBe(false);

    await expect(removeInlineRuleFile(null)).resolves.toBeUndefined();
    await expect(removeInlineRuleFile('/tmp/zhshield-semgrep-not-exist/x.yml')).resolves.toBeUndefined();
  });
});

/**
 * CSRF 规则的命中正确性依赖写入器能发射「多行 pattern」：
 * semgrep 1.180.0 对 TS 装饰器只能用「装饰器 + 方法签名」的多行 pattern 匹配，
 * 单行 `@Post(...)` / 裸 `@$X` 零命中。csrf.yml 现用多行 patternEither + 多行 pattern-not，
 * 本用例锁死写入器确实把它们原样发射成 block scalar（否则 csrf 会静默零命中 = 假阴性）。
 */
describe('SemgrepRuleWriter — 多行 pattern / pattern-not 发射（csrf 依赖）', () => {
  it('多行 patternEither 与多行 pattern-not 都被发射为 block scalar', async () => {
    const projectDir = makeProjectDir();
    const writer = new SemgrepRuleWriter();
    const rulePath = await writer.writeInlineRuleConfig({
      projectPath: projectDir,
      config: {
        rules: [
          {
            id: 'missing-csrf-nestjs',
            severity: 'warning',
            patternEither: ['@Post()\n  $M(...)', '@Post($PATH)\n  $M(...)'],
            patternNot: ['@UseGuards(...)\n  $M2(...)'],
            message: 'missing csrf guard',
          },
        ],
      },
    } as unknown as ToolScanOptions);

    const p = rulePath as string;
    tempDirs.push(path.dirname(p));
    const yaml = fs.readFileSync(p, 'utf-8');

    // pattern-either 内存在装饰器 + 方法多行结构
    expect(yaml).toContain('pattern-either:');
    expect(yaml).toContain('@Post()');
    expect(yaml).toContain('$M(...)');
    // pattern-not 以 block scalar 形式存在（含装饰器 + 方法）
    expect(yaml).toContain('pattern-not: |');
    expect(yaml).toContain('@UseGuards(...)');
  });
});
