import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  appendDomainHistory,
  buildRecordFromFingerprints,
  buildScanRecord,
  diffScans,
  getLatestHistoryRecord,
  hashFingerprints,
  isDomainKey,
  listDomainHistory,
  normalizeFingerprint,
  parseHistoryLines,
  readScanBlob,
  resolveFingerprints,
  type DomainScanRecord,
} from '../../electron/domain-history';
import type { DiagnosticEntry } from '../../electron/zh-diagnostics-types';
import { listDomainHistoryHandler } from '../../electron/ipc/domain-history-ipc';

const evt = {} as Electron.IpcMainInvokeEvent;

/**
 * 域级扫描历史（`.zhshield/history/<domain>.jsonl`）。
 *
 * 这份契约要守住的四件事：
 * 1. **每次一条**：同一次扫描重复写盘不得伪造出第二条；
 * 2. **跨目录可比**：指纹里的绝对路径必须相对化，否则项目换目录后全部「新增 + 消失」；
 * 3. **体积可控**：指纹集不变时不重复存全量（写 sameAs 指针）；
 * 4. **涨跌可解释**：diff 要能给出新增 / 修复 / 遗留 + 分数变化，首次扫描不得编造涨跌。
 */

function makeEntry(
  overrides: Partial<DiagnosticEntry> & Pick<DiagnosticEntry, 'fingerprint'>,
): DiagnosticEntry {
  return {
    ruleId: 'rule.x',
    severity: 'warning',
    category: 'quality',
    message: '示例问题',
    file: 'src/a.ts',
    autoFixable: false,
    source: 'inspect',
    ...overrides,
  };
}

function tempProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zh-domain-history-'));
}

function recordInput(
  projectPath: string,
  scannedAt: string,
  fingerprints: string[],
  score: number | null = null,
) {
  return buildRecordFromFingerprints({
    domain: 'inspect',
    scannedAt,
    recordedAt: new Date().toISOString(),
    fingerprints,
    score,
  });
}

describe('指纹相对化与 hash', () => {
  it('剥掉项目绝对路径前缀（换目录后指纹不变）', () => {
    const fp = 'duplicated-code:/Users/a/proj/src/x.ts:12';
    expect(normalizeFingerprint(fp, '/Users/a/proj')).toBe('duplicated-code:src/x.ts:12');
  });

  it('不含项目路径的指纹原样保留', () => {
    const fp = 'inspect.scan.official.duplication:src/x.ts:12';
    expect(normalizeFingerprint(fp, '/Users/a/proj')).toBe(fp);
  });

  it('hash 与顺序无关（扫描输出顺序抖动不算变化）', () => {
    expect(hashFingerprints(['b', 'a'])).toBe(hashFingerprints(['a', 'b']));
    expect(hashFingerprints(['a'])).not.toBe(hashFingerprints(['a', 'b']));
  });
});

describe('buildScanRecord', () => {
  it('按 severity 计数，并相对化指纹', () => {
    const project = '/tmp/proj';
    const record = buildScanRecord({
      domain: 'inspect',
      scannedAt: '2026-10-24T00:00:00.000Z',
      recordedAt: '2026-10-24T00:00:01.000Z',
      projectPath: project,
      issues: [
        makeEntry({ fingerprint: `${project}/src/a.ts:1`, severity: 'error' }),
        makeEntry({ fingerprint: `${project}/src/b.ts:2`, severity: 'warning' }),
        makeEntry({ fingerprint: `${project}/src/c.ts:3`, severity: 'info' }),
      ],
      score: 88.5,
    });
    expect(record.total).toBe(3);
    expect(record.error).toBe(1);
    expect(record.warning).toBe(1);
    expect(record.info).toBe(1);
    expect(record.score).toBe(88.5);
    expect(record.fingerprints).toEqual(['src/a.ts:1', 'src/b.ts:2', 'src/c.ts:3']);
    expect(record.scanId).toHaveLength(16);
  });

  it('不出分的域 score 为 null（不是 0）', () => {
    const record = buildRecordFromFingerprints({
      domain: 'garbage',
      scannedAt: '2026-10-24T00:00:00.000Z',
      recordedAt: '2026-10-24T00:00:00.000Z',
      fingerprints: ['garbage:dead-code:src/a.ts'],
      total: 1,
      score: null,
      severityApplicable: false,
    });
    expect(record.score).toBeNull();
    expect(record.severityApplicable).toBe(false);
  });
});

describe('解析与指针解压', () => {
  it('坏行跳过，其余照常解析（进程被杀留下的半行不毁整段历史）', () => {
    const good = JSON.stringify(recordInput('/p', '2026-10-24T00:00:00.000Z', ['a']));
    const records = parseHistoryLines(`${good}\n{"broken":\n\n${good.replace('a]', 'b]')}`);
    expect(records).toHaveLength(2);
  });

  it('sameAs 指向的记录被补齐完整指纹集', () => {
    const first = recordInput('/p', '2026-10-24T00:00:00.000Z', ['a', 'b']);
    const compact: DomainScanRecord = {
      ...recordInput('/p', '2026-10-24T01:00:00.000Z', ['a', 'b']),
      fingerprints: undefined,
      sameAs: first.scanId,
    };
    const resolved = resolveFingerprints([first, compact]);
    expect(resolved[1].fingerprints).toEqual(['a', 'b']);
  });
});

describe('appendDomainHistory', () => {
  it('写入后可按新→旧读回', async () => {
    const project = tempProject();
    await appendDomainHistory(project, recordInput(project, '2026-10-24T00:00:00.000Z', ['a'], 90));
    await appendDomainHistory(project, recordInput(project, '2026-10-24T01:00:00.000Z', ['a', 'b'], 85));
    const history = await listDomainHistory(project, 'inspect');
    expect(history).toHaveLength(2);
    expect(history[0].scannedAt).toBe('2026-10-24T01:00:00.000Z');
    expect(history[0].score).toBe(85);
  });

  it('同一次扫描重复写入 → duplicate，不产生第二条', async () => {
    const project = tempProject();
    const record = recordInput(project, '2026-10-24T00:00:00.000Z', ['a']);
    expect(await appendDomainHistory(project, record)).toBe('appended');
    expect(await appendDomainHistory(project, { ...record, recordedAt: new Date().toISOString() })).toBe(
      'duplicate',
    );
    expect(await listDomainHistory(project, 'inspect')).toHaveLength(1);
  });

  it('指纹集未变 → 只写 sameAs 指针，不重复存全量', async () => {
    const project = tempProject();
    await appendDomainHistory(project, recordInput(project, '2026-10-24T00:00:00.000Z', ['a', 'b']));
    await appendDomainHistory(
      project,
      recordInput(project, '2026-10-24T01:00:00.000Z', ['b', 'a']),
    );
    const raw = fs.readFileSync(path.join(project, '.zhshield', 'history', 'inspect.jsonl'), 'utf-8');
    const lines = raw.trim().split('\n').map((line) => JSON.parse(line) as DomainScanRecord);
    expect(lines[1].fingerprints).toBeUndefined();
    expect(lines[1].sameAs).toBe(lines[0].scanId);
    // 读回时仍然是完整指纹集（指针已解压，复用上一条的数组）
    expect((await listDomainHistory(project, 'inspect'))[0].fingerprints).toEqual(['a', 'b']);
  });

  it('指纹集变化 + 给了 entries → 落明细 blob 并可读回', async () => {
    const project = tempProject();
    const entries = [
      makeEntry({ fingerprint: `${project}/src/a.ts:1`, message: '第一条' }),
    ];
    const record = buildScanRecord({
      domain: 'inspect',
      scannedAt: '2026-10-24T00:00:00.000Z',
      recordedAt: new Date().toISOString(),
      projectPath: project,
      issues: entries,
      score: 90,
    });
    await appendDomainHistory(project, record, entries);
    const latest = await getLatestHistoryRecord(project, 'inspect');
    expect(latest?.blob).toBeTruthy();
    const blob = await readScanBlob(project, latest!.blob!);
    expect(blob?.entries[0].message).toBe('第一条');
  });

  it('超过上限只保留最近 limit 条（生产默认 HISTORY_LIMIT）', async () => {
    const project = tempProject();
    const keep = 5;
    for (let i = 0; i < keep + 3; i += 1) {
      const stamp = new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString();
      await appendDomainHistory(project, recordInput(project, stamp, [`fp-${i}`]), undefined, keep);
    }
    const raw = fs.readFileSync(path.join(project, '.zhshield', 'history', 'inspect.jsonl'), 'utf-8');
    expect(raw.trim().split('\n')).toHaveLength(keep);
    const history = await listDomainHistory(project, 'inspect', keep);
    expect(history[0].fingerprints).toEqual([`fp-${keep + 2}`]);
  });

  it('非法域名 → skipped（拒绝路径穿越）', async () => {
    const project = tempProject();
    const record = recordInput(project, '2026-10-24T00:00:00.000Z', ['a']);
    expect(await appendDomainHistory(project, { ...record, domain: '../escape' })).toBe('skipped');
  });
});

describe('diffScans', () => {
  const base = recordInput('/p', '2026-10-24T00:00:00.000Z', ['a', 'b'], 90);
  const next = recordInput('/p', '2026-10-24T01:00:00.000Z', ['b', 'c'], 85);

  it('给出新增 / 修复 / 遗留与分数变化', () => {
    const diff = diffScans(base, next);
    expect(diff.added).toEqual(['c']);
    expect(diff.removed).toEqual(['a']);
    expect(diff.persisting).toBe(1);
    expect(diff.scoreDelta).toBe(-5);
    expect(diff.totalDelta).toBe(0);
  });

  it('首次扫描：没有基线就不编造涨跌', () => {
    const diff = diffScans(null, next);
    expect(diff.scoreDelta).toBeNull();
    expect(diff.added).toEqual(['b', 'c']);
    expect(diff.removed).toEqual([]);
  });

  it('任一侧无分数 → scoreDelta 为 null（不把 null 当 0）', () => {
    const noScore = recordInput('/p', '2026-10-24T02:00:00.000Z', ['a'], null);
    expect(diffScans(noScore, next).scoreDelta).toBeNull();
  });
});

describe('域白名单', () => {
  it('只接受已知域，拒绝穿越与大小写变形', () => {
    expect(isDomainKey('inspect')).toBe(true);
    expect(isDomainKey('garbage')).toBe(true);
    expect(isDomainKey('../escape')).toBe(false);
    expect(isDomainKey('Inspect')).toBe(false);
    expect(isDomainKey('secrets')).toBe(false);
  });
});

describe('listDomainHistoryHandler 回填（升级前的数据）', () => {
  function writeSnapshot(project: string, domain: string, payload: unknown): void {
    const dir = path.join(project, '.zhshield', 'diagnostics', 'domains');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${domain}.json`), JSON.stringify(payload), 'utf-8');
  }

  it('没有历史文件但有快照 → 回填一条只读记录（时间 / 分数 / 相对指纹）', async () => {
    const project = tempProject();
    writeSnapshot(project, 'inspect', {
      generatedAt: '2026-10-23T16:16:15.872Z',
      summary: { total: 2, error: 1, warning: 1, info: 0 },
      issues: [
        { fingerprint: `inspect.dup:${project}/src/a.ts:1`, severity: 'error' },
        { fingerprint: `inspect.dup:${project}/src/b.ts:2`, severity: 'warning' },
      ],
      dimensionScore: { dimension: 'quality', score: 89.5, issues: 2, status: 'scored', version: 3 },
    });

    const list = await listDomainHistoryHandler(evt, project, 'inspect');
    expect(list).toHaveLength(1);
    expect(list[0].backfilled).toBe(true);
    expect(list[0].score).toBe(89.5);
    expect(list[0].scannedAt).toBe('2026-10-23T16:16:15.872Z');
    expect(list[0].error).toBe(1);
    expect(list[0].fingerprints).toEqual(['inspect.dup:src/a.ts:1', 'inspect.dup:src/b.ts:2']);
    // 回填不落盘：历史文件不应被创建
    expect(fs.existsSync(path.join(project, '.zhshield', 'history', 'inspect.jsonl'))).toBe(false);
  });

  it('垃圾清理的 items 快照 → 合成指纹，且标注无严重级别', async () => {
    const project = tempProject();
    writeSnapshot(project, 'garbage', {
      timestamp: '2026-10-23T15:19:32.924Z',
      summary: { total: 1, size: 0, byType: { 'dead-code': 1 } },
      items: [{ type: 'dead-code', path: `${project}/src/x.ts`, size: 0 }],
      checks: [],
      skipped: 0,
    });

    const list = await listDomainHistoryHandler(evt, project, 'garbage');
    expect(list).toHaveLength(1);
    expect(list[0].severityApplicable).toBe(false);
    expect(list[0].total).toBe(1);
    expect(list[0].fingerprints).toEqual(['garbage:dead-code:src/x.ts']);
  });

  it('非法域 → 空数组（不读盘、不抛错）', async () => {
    const project = tempProject();
    expect(await listDomainHistoryHandler(evt, project, '../escape')).toEqual([]);
  });

  it('既无历史也无快照 → 空数组', async () => {
    const project = tempProject();
    expect(await listDomainHistoryHandler(evt, project, 'security')).toEqual([]);
  });
});
