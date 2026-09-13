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
