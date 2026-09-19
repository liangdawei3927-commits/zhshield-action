import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import {
  buildDiagnosticsReport,
  writeDiagnosticsFile,
  readDomainSnapshot,
  type DiagnosticEntry,
} from '../../electron/zh-diagnostics';

/**
 * 巡检实时评分（2026-09-19 批 9）
 *
 * 用户侧诉求：体检页每次点「马上巡检」后**当场知道多少分**，而不是必须去
 * 报告中心手动「汇总生成报告」才见分。
 *
 * 语义（单一来源）：writeDiagnosticsFile 写 inspect 按域快照时，用
 * @zh/scoring 的 buildHealthDimensions（quality 维扣分制：error -8 / warning -4 /
 * info -1，下限 0）对本次快照条目算分，附加为 snapshot.dimensionScore。
 * 渲染层只读不算 —— 与报告中心汇总、全局总分共用同一个评分函数，
 * 不产生第三套算法。跑过 0 检出 → 100 分同样覆盖写（0 检出语义与批「域快照」一致）。
 * guard 等其余域快照暂不附分（gate 维需 status/blocking 语义，快照条目不带），
 * 其分类页评分卡仍读报告中心汇总。
 */
function entry(over: Partial<DiagnosticEntry>): DiagnosticEntry {
  return {
    ruleId: 'rule-x',
    severity: 'error',
    category: 'quality',
    message: 'msg',
    file: 'src/a.ts',
    line: 1,
    autoFixable: false,
    source: 'inspect',
    fingerprint: 'fp-default',
    ...over,
  };
}

describe('巡检实时评分写入按域快照', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = path.join(os.tmpdir(), `zhshield-livescore-${crypto.randomUUID()}`);
    fs.mkdirSync(projectDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('inspect 快照必须带 dimensionScore：1 error + 1 warning = 88 分', async () => {
    const project = { path: projectDir, name: path.basename(projectDir) };
    await writeDiagnosticsFile(
      buildDiagnosticsReport(
        project,
        [
          entry({ fingerprint: 'fp-1', severity: 'error' }),
          entry({ fingerprint: 'fp-2', severity: 'warning' }),
        ],
        '2026-09-19T10:00:00.000Z',
      ),
      ['inspect'],
    );

    const snap = await readDomainSnapshot(projectDir, 'inspect');
    expect(snap).not.toBeNull();
    const s = snap?.dimensionScore;
    expect(s, 'inspect 快照必须携带评分').toBeDefined();
    expect(s?.dimension).toBe('quality');
    expect(s?.score).toBe(88); // 100 - 8 - 4
    expect(s?.issues).toBe(2);
    expect(s?.status).toBe('scored');
  });

  it('跑过 0 检出必须覆盖写 100 分（不得留着旧低分）', async () => {
    const project = { path: projectDir, name: path.basename(projectDir) };
    await writeDiagnosticsFile(
      buildDiagnosticsReport(project, [entry({ fingerprint: 'fp-1' })], '2026-09-19T10:00:00.000Z'),
      ['inspect'],
    );
    await writeDiagnosticsFile(
      buildDiagnosticsReport(project, [], '2026-09-19T11:00:00.000Z'),
      ['inspect'],
    );

    const snap = await readDomainSnapshot(projectDir, 'inspect');
    expect(snap?.issues.length).toBe(0);
    expect(snap?.dimensionScore?.score, '修干净后当场应为满分').toBe(100);
    expect(snap?.dimensionScore?.status).toBe('scored');
  });

  it('guard 快照不带 dimensionScore（gate 维语义不同，暂不实时评分）', async () => {
    const project = { path: projectDir, name: path.basename(projectDir) };
    await writeDiagnosticsFile(
      buildDiagnosticsReport(
        project,
        [entry({ fingerprint: 'g-1', source: 'guard' })],
        '2026-09-19T10:00:00.000Z',
      ),
      ['guard'],
    );

    const snap = await readDomainSnapshot(projectDir, 'guard');
    expect(snap).not.toBeNull();
    expect(snap?.dimensionScore).toBeUndefined();
  });

  it('旧格式快照（无 dimensionScore）仍可正常读取', async () => {
    const dir = path.join(projectDir, '.zhshield', 'diagnostics', 'domains');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'inspect.json'),
      JSON.stringify({
        version: '1.0',
        project: { path: projectDir, name: 'x' },
        generatedAt: '2026-09-18T10:00:00.000Z',
        summary: { total: 0, error: 0, warning: 0, info: 0 },
        issues: [],
        files: [],
      }),
      'utf-8',
    );

    const snap = await readDomainSnapshot(projectDir, 'inspect');
    expect(snap, '旧快照必须仍可读（向后兼容）').not.toBeNull();
    expect(snap?.dimensionScore).toBeUndefined();
  });
});
