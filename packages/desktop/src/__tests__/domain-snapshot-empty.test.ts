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
 * 域快照「0 检出」语义（2026-09-18）
 *
 * 用户侧现象：把某域报出的问题全部修好、重新检查，**界面上那条问题还在**。
 *
 * 机理：`writeDiagnosticsFile` 是「按 issues 反推有哪些域」，即
 * `for (const entry of report.issues) perSource.set(entry.source, …)`，
 * 并在 `perSource.size === 0` 时直接 return。于是某域**跑完 0 检出**时
 * 根本不会写出该域快照 —— 磁盘上留着上一次那份「有问题」的快照，
 * 而界面读的正是它。结果：**修干净了反而永远显示旧问题**。
 *
 * 正确语义：一个域**跑过**就必须覆盖写它的快照（哪怕 0 条），
 * 「没跑过」才保留旧快照。这两者必须区分，否则分不清「没查」与「查了没问题」。
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

describe('域快照与 0 检出', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = path.join(os.tmpdir(), `zhshield-domainsnap-${crypto.randomUUID()}`);
    fs.mkdirSync(projectDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('某域从「有 2 条」变为「0 条」时，旧快照必须被覆盖为空', async () => {
    const project = { path: projectDir, name: path.basename(projectDir) };

    // 第一次检查：inspect 报出 2 条问题
    await writeDiagnosticsFile(
      buildDiagnosticsReport(
        project,
        [
          entry({ fingerprint: 'fp-1', file: 'src/a.ts' }),
          entry({ fingerprint: 'fp-2', file: 'src/b.ts' }),
        ],
        '2026-09-18T10:00:00.000Z',
      ),
      ['inspect'],
    );
    expect((await readDomainSnapshot(projectDir, 'inspect'))?.issues.length).toBe(2);

    // 第二次检查：问题已全部修复，inspect 跑过但 0 检出（必须显式声明「跑过」）
    await writeDiagnosticsFile(buildDiagnosticsReport(project, [], '2026-09-18T11:00:00.000Z'), [
      'inspect',
    ]);

    const after = await readDomainSnapshot(projectDir, 'inspect');
    expect(after, '域快照应当存在（该域跑过）').not.toBeNull();
    expect(after?.issues.length, '域已重新跑过且 0 检出，旧问题不得继续留在快照里').toBe(0);
  });

  it('没跑过的域必须保留旧快照（不得把别域数据一并擦掉）', async () => {
    const project = { path: projectDir, name: path.basename(projectDir) };

    await writeDiagnosticsFile(
      buildDiagnosticsReport(
        project,
        [
          entry({ fingerprint: 'g-1', source: 'guard', file: 'src/g.ts' }),
          entry({ fingerprint: 'i-1', source: 'inspect', file: 'src/i.ts' }),
        ],
        '2026-09-18T10:00:00.000Z',
      ),
      ['guard', 'inspect'],
    );

    // 只重跑 guard（0 检出）：inspect 这次没跑，其快照必须原样保留
    await writeDiagnosticsFile(buildDiagnosticsReport(project, [], '2026-09-18T11:00:00.000Z'), [
      'guard',
    ]);

    expect((await readDomainSnapshot(projectDir, 'guard'))?.issues.length).toBe(0);
    expect(
      (await readDomainSnapshot(projectDir, 'inspect'))?.issues.length,
      'inspect 这次没跑，旧快照不得被擦除',
    ).toBe(1);
  });
});
