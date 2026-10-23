import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeDiagnosticsFile } from '../../electron/zh-diagnostics-persist';
import type { DiagnosticEntry, DiagnosticsReport } from '../../electron/zh-diagnostics-types';

/**
 * 落盘链路是否真的写了历史。
 *
 * 这份测试防的是「声明了却没执行」：`recordScanHistory` 写在 `writeDomainSnapshots` 里，
 * 如果只是加了函数、没接进写入链，快照照样落盘、历史却是空的 —— 页面上一片正常，
 * 功能实际没生效。所以这里直接调真实落盘入口，断言产物文件。
 */

function tempProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zh-history-write-'));
}

function report(projectPath: string, issues: DiagnosticEntry[]): DiagnosticsReport {
  return {
    version: '1.0',
    project: { path: projectPath, name: 'demo' },
    generatedAt: '2026-10-24T00:30:00.000Z',
    summary: {
      total: issues.length,
      error: issues.filter((i) => i.severity === 'error').length,
      warning: issues.filter((i) => i.severity === 'warning').length,
      info: issues.filter((i) => i.severity === 'info').length,
    },
    issues,
    files: [],
  };
}

const entry: DiagnosticEntry = {
  ruleId: 'inspect.scan.official.duplication',
  severity: 'warning',
  category: 'quality',
  message: '重复代码块',
  file: 'src/a.ts',
  line: 10,
  autoFixable: false,
  source: 'inspect',
  fingerprint: 'inspect.scan.official.duplication:src/a.ts:10',
};

describe('writeDiagnosticsFile → 域历史', () => {
  it('快照落盘的同时追加一条历史（含分数与指纹）', async () => {
    const project = tempProject();
    await writeDiagnosticsFile(report(project, [entry]), ['inspect']);

    const snapshotPath = path.join(project, '.zhshield', 'diagnostics', 'domains', 'inspect.json');
    const historyPath = path.join(project, '.zhshield', 'history', 'inspect.jsonl');
    expect(fs.existsSync(snapshotPath)).toBe(true);
    expect(fs.existsSync(historyPath)).toBe(true);

    const lines = fs.readFileSync(historyPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]) as {
      scannedAt: string;
      total: number;
      warning: number;
      score: number | null;
      fingerprints: string[];
    };
    expect(record.scannedAt).toBe('2026-10-24T00:30:00.000Z');
    expect(record.total).toBe(1);
    expect(record.warning).toBe(1);
    // inspect 当场出 quality 分（enrichInspectSnapshot）→ 历史里必须带上
    expect(typeof record.score).toBe('number');
    expect(record.fingerprints).toEqual(['inspect.scan.official.duplication:src/a.ts:10']);
  });

  it('同一份快照被重复落盘 → 历史仍只有一条（不伪造「又扫了一次」）', async () => {
    const project = tempProject();
    await writeDiagnosticsFile(report(project, [entry]), ['inspect']);
    await writeDiagnosticsFile(report(project, [entry]), ['inspect']);

    const lines = fs
      .readFileSync(path.join(project, '.zhshield', 'history', 'inspect.jsonl'), 'utf-8')
      .trim()
      .split('\n');
    expect(lines).toHaveLength(1);
  });

  it('未运行的域不产生历史（不拿空数组冒充「扫过了」）', async () => {
    const project = tempProject();
    await writeDiagnosticsFile(report(project, [entry]), ['inspect']);
    expect(
      fs.existsSync(path.join(project, '.zhshield', 'history', 'refactor.jsonl')),
    ).toBe(false);
  });
});
