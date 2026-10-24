import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  saveDomainReportHandler,
  getSavedDomainReportHandler,
  hasDomainResultHandler,
} from '../../electron/ipc/domain-reports';

/**
 * 分类页完整报告落盘 / 读回。
 *
 * 背景：页面 `report` 只在内存，退出即丢；评分却读磁盘 → 出现「有评分、没详情按钮」。
 * 修法不是把内存 report 改成磁盘读，而是**扫描成功时把完整报告原样落一份盘**，
 * 打开页面时读回。因此这份契约的核心是「原样」：读回 === 写入，不做字段再造、
 * 不做问题条目归一化（那会丢掉 outdated / smells / debtIndex 等域特有结构）。
 */

const evt = {} as Electron.IpcMainInvokeEvent;
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zh-domain-reports-'));

describe('domain-reports 落盘与读回', () => {
  it('落盘后原样读回（同一份数据，不改造任何字段）', async () => {
    const report = {
      schemaVersion: 1,
      direct: 12,
      outdated: [{ name: 'left-pad', current: '1.0.0', latest: '2.0.0' }],
      lockfile: { present: true, consistent: false },
    };
    expect(await saveDomainReportHandler(evt, projectDir, 'deps', report)).toBe(true);

    const back = await getSavedDomainReportHandler(evt, projectDir, 'deps');
    expect(back).toEqual(report);
    expect(fs.existsSync(path.join(projectDir, '.zhshield', 'reports', 'deps.json'))).toBe(true);
  });

  it('没落盘过 → null（不猜、不造空报告）', async () => {
    expect(await getSavedDomainReportHandler(evt, projectDir, 'techdebt')).toBeNull();
  });

  it('域标识非法 / 路径穿越一律拒绝，不写到项目外', async () => {
    expect(await saveDomainReportHandler(evt, projectDir, '../escape', { a: 1 })).toBe(false);
    expect(await saveDomainReportHandler(evt, projectDir, '..', { a: 1 })).toBe(false);
    expect(await saveDomainReportHandler(evt, projectDir, 'Deps', { a: 1 })).toBe(false);
    expect(await getSavedDomainReportHandler(evt, projectDir, '../escape')).toBeNull();
    expect(fs.existsSync(path.join(projectDir, '..', 'escape.json'))).toBe(false);
  });

  it('非对象内容不落盘（避免写入 null/字符串污染回看）', async () => {
    expect(await saveDomainReportHandler(evt, projectDir, 'garbage', null)).toBe(false);
    expect(await saveDomainReportHandler(evt, projectDir, 'garbage', 'oops')).toBe(false);
  });
});

describe('「该域是否跑过」判定（详情入口可见性的唯一判据）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zh-has-result-'));
  const domainDir = path.join(dir, '.zhshield', 'diagnostics', 'domains');

  it('什么都没有 → false（没扫描过就不给按钮）', async () => {
    expect(await hasDomainResultHandler(evt, dir, 'performance')).toBe(false);
  });

  it('只有归一化快照（旧数据，评分由此计算）→ true', async () => {
    fs.mkdirSync(domainDir, { recursive: true });
    fs.writeFileSync(
      path.join(domainDir, 'performance.json'),
      JSON.stringify({ summary: { total: 0 }, issues: [] }),
      'utf-8',
    );
    expect(await hasDomainResultHandler(evt, dir, 'performance')).toBe(true);
  });

  it('只有完整报告（新版扫描）→ true', async () => {
    await saveDomainReportHandler(evt, dir, 'techdebt', { debtIndex: 12 });
    expect(await hasDomainResultHandler(evt, dir, 'techdebt')).toBe(true);
  });

  it('非法域标识 → false（不做越界探测）', async () => {
    expect(await hasDomainResultHandler(evt, dir, '../escape')).toBe(false);
  });
});

describe('六个分类页都已接上「读回上次报告 → 详情入口」', () => {
  const pagesDir = path.resolve(__dirname, '../pages');
  // openDetail / 快照视图已收敛到 hook：守护断言同时覆盖「页面接线」与「实现本身」
  const hookSrc = fs.readFileSync(
    path.resolve(__dirname, '../hooks/useDomainDetailEntry.ts'),
    'utf-8',
  );
  // 依赖 / 垃圾 / 技术债 / 性能：四页结构相同，接线到合并入口 useDomainDetailPage
  const sharedPages: Array<[string, string]> = [
    ['DependencyPage.tsx', 'deps'],
    ['GarbagePage.tsx', 'garbage'],
    ['TechDebtPage.tsx', 'techdebt'],
    ['PerformancePage.tsx', 'performance'],
  ];
  // 重构 / 安全：页面另有独立视图状态，仍直接使用底层 hook
  const directPages = ['RefactorPage.tsx', 'SecurityPage.tsx'];

  it('合并入口内保留「实时优先、扫描中不顶替」与详情入口判据', () => {
    // 四个域页面共用这一份实现 → 判据只在这一处，页面不再各存一份
    expect(hookSrc).toMatch(/liveReport \?\? \(loading \? null : savedReport\)/);
    expect(hookSrc).toContain('hasDetail = detailReport !== null || hadPreviousResult;');
  });

  it('openDetail 绝不触发扫描（点详情 ≠ 重新检查）', () => {
    const start = hookSrc.indexOf('const openDetail = useCallback(');
    expect(start, 'openDetail 缺失').toBeGreaterThan(-1);
    const block = hookSrc.slice(start, start + 400);
    // 关键回归：openDetail 里绝不能调扫描 —— 那等于「点详情就开始扫描」
    expect(block, 'openDetail 不得触发扫描').not.toMatch(/onRescan|handleScan/);
    expect(block).toContain('setShowSnapshot(true)');
    expect(hookSrc).toContain('useDomainSnapshot(');
  });

  for (const [file, domain] of sharedPages) {
    it(`${file}：接线到合并入口（domain=${domain}），快照视图仍在页面`, () => {
      const src = fs.readFileSync(path.join(pagesDir, file), 'utf-8');
      // 页面必须把本域 domain / 实时报告 / 扫描入口交给合并入口，不能自带一份派生逻辑
      expect(src).toContain(
        `useDomainDetailPage(projectPath, '${domain}', report, loading, handleScan)`,
      );
      // 详情入口是否可见仍以合并入口的判定为唯一来源
      expect(src).toContain('detail.hasDetail');
      // 无完整报告时打开「上次结果」视图（快照视图渲染仍在页面，故断言页面）
      expect(src).toContain('<DomainSnapshotReport');
      // 不允许页面再各自复制一份派生逻辑（否则等于没收敛）
      expect(src).not.toContain('useSavedDomainReport');
      expect(src).not.toMatch(/hasDetail = detailReport !== null/);
    });
  }

  for (const file of directPages) {
    it(`${file}：使用 useSavedDomainReport，且实时结果优先`, () => {
      const src = fs.readFileSync(path.join(pagesDir, file), 'utf-8');
      expect(src).toContain('useSavedDomainReport');
      // 实时优先 + 扫描中不用旧报告顶替
      expect(src).toMatch(/report \?\? \((loading|scanning) \? null : saved(Report)?\)/);
    });

    it(`${file}：详情入口 = 「有结果」(实时/完整报告/历史落盘)，无结果不显示`, () => {
      const src = fs.readFileSync(path.join(pagesDir, file), 'utf-8');
      // 有分（=磁盘有结果）就要有按钮；不再只看内存 report
      expect(src).toMatch(/hasDetail = detailReport !== null \|\| hadPreviousResult;/);
      // 详情入口统一由 useDomainDetailEntry 提供（openDetail / 快照视图只有一份实现）
      expect(src).toContain('useDomainDetailEntry({');
    });

    it(`${file}：点详情直接看上次结果，不发起扫描`, () => {
      const src = fs.readFileSync(path.join(pagesDir, file), 'utf-8');
      expect(src).toContain('useDomainDetailEntry({');
      // 无完整报告时打开「上次结果」视图（快照视图渲染仍在页面，故断言页面）
      expect(src).toContain('<DomainSnapshotReport');
    });
  }
});
