import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  baselinePath,
  normalizeBaselineFile,
  baselineEntryKey,
  toBaselineEntry,
  baselineKeySet,
  isBaselineEntryActive,
  filterIssuesByBaseline,
  loadBaseline,
  saveBaseline,
  clearBaseline,
  issuesToBaselineEntries,
  type Baseline,
} from '../baseline';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zhshield-baseline-'));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

const sampleIssues = [
  { ruleId: 'inspect.scan.official.type-safety', file: '/work/src/a.ts', line: 10, column: 5 },
  { ruleId: 'semgrep.path-traversal', file: '/work/src/b.ts', line: 20, column: 0 },
];

describe('baselineEntryKey / toBaselineEntry', () => {
  it('normalizes absolute file to project-relative forward-slash path', () => {
    const entry = toBaselineEntry(sampleIssues[0], '/work');
    expect(entry.file).toBe('src/a.ts');
    expect(baselineEntryKey(entry)).toBe('inspect.scan.official.type-safety:src/a.ts:10:5');
  });

  it('keeps relative file as-is and defaults missing line/column to 0', () => {
    const entry = toBaselineEntry({ ruleId: 'r', file: 'src/c.ts' }, '/work');
    expect(entry.file).toBe('src/c.ts');
    expect(entry.line).toBe(0);
    expect(entry.column).toBe(0);
  });

  it('replaces win32 backslashes with forward slashes', () => {
    expect(normalizeBaselineFile('src\\deep\\d.ts', '/work')).toBe('src/deep/d.ts');
  });
});

describe('baselineKeySet', () => {
  it('builds key set from entries', () => {
    const baseline: Baseline = {
      version: 1,
      capturedAt: '2026-01-01T00:00:00.000Z',
      entries: [toBaselineEntry(sampleIssues[0], '/work')],
    };
    const keys = baselineKeySet(baseline);
    expect(keys.has('inspect.scan.official.type-safety:src/a.ts:10:5')).toBe(true);
    expect(keys.size).toBe(1);
  });
});

describe('filterIssuesByBaseline', () => {
  it('returns all issues when baseline is null', () => {
    const { kept, suppressed } = filterIssuesByBaseline(sampleIssues, null, '/work');
    expect(kept).toHaveLength(2);
    expect(suppressed).toBe(0);
  });

  it('removes matching issues and counts them; does not mutate input', () => {
    const baseline: Baseline = {
      version: 1,
      capturedAt: '2026-01-01T00:00:00.000Z',
      entries: [toBaselineEntry(sampleIssues[0], '/work')],
    };
    const { kept, suppressed } = filterIssuesByBaseline(sampleIssues, baseline, '/work');
    expect(suppressed).toBe(1);
    expect(kept).toHaveLength(1);
    expect(kept[0].ruleId).toBe('semgrep.path-traversal');
    expect(sampleIssues).toHaveLength(2);
  });

  it('returns all issues for an empty baseline', () => {
    const baseline: Baseline = { version: 1, capturedAt: '', entries: [] };
    const { kept, suppressed } = filterIssuesByBaseline(sampleIssues, baseline, '/work');
    expect(kept).toHaveLength(2);
    expect(suppressed).toBe(0);
  });
});

describe('loadBaseline / saveBaseline / clearBaseline', () => {
  it('saves and round-trips baseline.json under .zhshield/', async () => {
    const entries = issuesToBaselineEntries(sampleIssues, '/work');
    const saved = await saveBaseline(tmpRoot, entries);
    expect(saved.version).toBe(1);
    expect(saved.entries).toHaveLength(2);
    expect(saved.capturedAt).toBeTruthy();
    expect(baselinePath(tmpRoot)).toBe(path.join(tmpRoot, '.zhshield', 'baseline.json'));

    const loaded = await loadBaseline(tmpRoot);
    expect(loaded).not.toBeNull();
    expect(loaded!.entries).toHaveLength(2);
  });

  it('returns null when file does not exist', async () => {
    expect(await loadBaseline(tmpRoot)).toBeNull();
  });

  it('returns null for corrupt / wrong-version files without throwing', async () => {
    const dir = path.join(tmpRoot, '.zhshield');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'baseline.json'), '{not json', 'utf-8');
    expect(await loadBaseline(tmpRoot)).toBeNull();

    await fs.writeFile(
      path.join(dir, 'baseline.json'),
      JSON.stringify({ version: 99, capturedAt: '', entries: [] }),
      'utf-8',
    );
    expect(await loadBaseline(tmpRoot)).toBeNull();
  });

  it('clears baseline file; clearing a missing file is silent', async () => {
    await saveBaseline(tmpRoot, []);
    await clearBaseline(tmpRoot);
    expect(await loadBaseline(tmpRoot)).toBeNull();
    await expect(clearBaseline(tmpRoot)).resolves.toBeUndefined();
  });
});

describe('issuesToBaselineEntries', () => {
  it('maps issues to entries without throwing on missing positions', () => {
    const entries = issuesToBaselineEntries([{ ruleId: 'r', file: '/work/x.ts' }], '/work');
    expect(entries).toEqual([{ ruleId: 'r', file: 'x.ts', line: 0, column: 0 }]);
  });
});

describe('豁免治理字段：到期失效', () => {
  const NOW = Date.parse('2026-06-01T00:00:00.000Z');
  const base = { ruleId: 'r', file: 'src/a.ts', line: 10, column: 5 };

  it('无 expiresAt 视为永久豁免（早期条目）', () => {
    expect(isBaselineEntryActive(base, NOW)).toBe(true);
  });

  it('未到期仍生效，已到期失效', () => {
    expect(isBaselineEntryActive({ ...base, expiresAt: '2026-12-01T00:00:00.000Z' }, NOW)).toBe(true);
    expect(isBaselineEntryActive({ ...base, expiresAt: '2026-01-01T00:00:00.000Z' }, NOW)).toBe(false);
  });

  it('到期时间非法时保守判为失效，避免坏数据永久藏问题', () => {
    expect(isBaselineEntryActive({ ...base, expiresAt: 'not-a-date' }, NOW)).toBe(false);
  });

  it('baselineKeySet 排除已过期条目', () => {
    const baseline: Baseline = {
      version: 1,
      capturedAt: '2026-01-01T00:00:00.000Z',
      entries: [
        { ...base, expiresAt: '2026-12-01T00:00:00.000Z' },
        { ...base, ruleId: 'expired', expiresAt: '2026-01-01T00:00:00.000Z' },
      ],
    };
    const keys = baselineKeySet(baseline, NOW);
    expect(keys.has('r:src/a.ts:10:5')).toBe(true);
    expect(keys.has('expired:src/a.ts:10:5')).toBe(false);
  });

  it('filterIssuesByBaseline 不豁免已过期条目——问题重新计入报告', () => {
    const baseline: Baseline = {
      version: 1,
      capturedAt: '2026-01-01T00:00:00.000Z',
      entries: [{ ...base, expiresAt: '2026-01-01T00:00:00.000Z' }],
    };
    const { kept, suppressed } = filterIssuesByBaseline([sampleIssues[0]], baseline, '/work', NOW);
    expect(suppressed).toBe(0);
    expect(kept).toHaveLength(1);
  });
});

describe('豁免治理字段：理由/责任人落盘往返', () => {
  it('saveBaseline/loadBaseline 保留 reason/owner/expiresAt', async () => {
    const entry = {
      ruleId: 'security.scan.semgrep.path-traversal',
      file: 'packages/cli/src/index.ts',
      line: 43,
      column: 0,
      reason: '非注入边界：污点为 Node 已执行的脚本自身路径',
      owner: 'security',
      expiresAt: '2027-01-01T00:00:00.000Z',
    };
    await saveBaseline(tmpRoot, [entry]);
    const loaded = await loadBaseline(tmpRoot);
    expect(loaded?.entries).toEqual([entry]);
  });

  it('旧格式条目（无治理字段）仍可正常加载——升版不得丢存量豁免', async () => {
    await fs.mkdir(path.dirname(baselinePath(tmpRoot)), { recursive: true });
    await fs.writeFile(
      baselinePath(tmpRoot),
      JSON.stringify({
        version: 1,
        capturedAt: '2026-01-01T00:00:00.000Z',
        entries: [{ ruleId: 'r', file: 'x.ts', line: 0, column: 0 }],
      }),
      'utf-8',
    );
    const loaded = await loadBaseline(tmpRoot);
    expect(loaded?.entries).toHaveLength(1);
    expect(loaded?.entries[0].reason).toBeUndefined();
  });
});

describe('豁免清单审计：休眠/过期条目暴露', () => {
  const projectRoot = '/work';

  it('活跃但本轮未命中的条目进入 dormantEntries——清单不再静默占位', () => {
    const baseline: Baseline = {
      version: 1,
      capturedAt: '2026-01-01T00:00:00.000Z',
      entries: [toBaselineEntry(sampleIssues[1], projectRoot)],
    };
    const result = filterIssuesByBaseline([sampleIssues[0]], baseline, projectRoot);
    expect(result.suppressed).toBe(0);
    expect(result.dormantEntries).toHaveLength(1);
    expect(result.dormantEntries[0].ruleId).toBe('semgrep.path-traversal');
  });

  it('命中的条目只出现在 suppressedIssues，不重复计入 dormantEntries', () => {
    const baseline: Baseline = {
      version: 1,
      capturedAt: '2026-01-01T00:00:00.000Z',
      entries: [toBaselineEntry(sampleIssues[0], projectRoot)],
    };
    const result = filterIssuesByBaseline([sampleIssues[0]], baseline, projectRoot);
    expect(result.suppressed).toBe(1);
    expect(result.dormantEntries).toHaveLength(0);
  });

  it('已过期条目进 expiredEntries 且不参与匹配——它从 suppressedCount 里看不见，必须单独暴露', () => {
    const now = Date.parse('2026-06-01T00:00:00.000Z');
    const baseline: Baseline = {
      version: 1,
      capturedAt: '2026-01-01T00:00:00.000Z',
      entries: [
        {
          ...toBaselineEntry(sampleIssues[0], projectRoot),
          expiresAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    };
    const result = filterIssuesByBaseline([sampleIssues[0]], baseline, projectRoot, now);
    expect(result.expiredEntries).toHaveLength(1);
    expect(result.suppressed).toBe(0);
    expect(result.kept).toHaveLength(1);
    expect(result.dormantEntries).toHaveLength(0);
  });

  it('无基线 / 空基线时两类审计集合均为空', () => {
    const withoutBaseline = filterIssuesByBaseline([sampleIssues[0]], null, projectRoot);
    expect(withoutBaseline.dormantEntries).toEqual([]);
    expect(withoutBaseline.expiredEntries).toEqual([]);

    const emptyBaseline: Baseline = {
      version: 1,
      capturedAt: '2026-01-01T00:00:00.000Z',
      entries: [],
    };
    const withEmpty = filterIssuesByBaseline([sampleIssues[0]], emptyBaseline, projectRoot);
    expect(withEmpty.dormantEntries).toEqual([]);
    expect(withEmpty.expiredEntries).toEqual([]);
  });

  it('部分命中时 dormant 与 expired 同时可见——审计须覆盖两类冗余', () => {
    const now = Date.parse('2026-06-01T00:00:00.000Z');
    const baseline: Baseline = {
      version: 1,
      capturedAt: '2026-01-01T00:00:00.000Z',
      entries: [
        toBaselineEntry(sampleIssues[0], projectRoot),
        toBaselineEntry(sampleIssues[1], projectRoot),
        {
          ruleId: 'inspect.scan.stale.thing',
          file: 'src/old.ts',
          line: 3,
          column: 1,
          expiresAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    };
    const result = filterIssuesByBaseline([sampleIssues[0]], baseline, projectRoot, now);
    expect(result.suppressed).toBe(1);
    expect(result.dormantEntries.map((e) => e.ruleId)).toEqual(['semgrep.path-traversal']);
    expect(result.expiredEntries.map((e) => e.ruleId)).toEqual(['inspect.scan.stale.thing']);
  });
});
