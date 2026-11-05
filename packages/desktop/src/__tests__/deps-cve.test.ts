/**
 * P1-8 结构守卫：CVE 检测链路不许被改回去。
 *
 * 纯函数与在线查询的回归已随实现下沉到 `packages/pipeline/src/__tests__/deps-cve.test.ts`
 * （桌面端与 CLI 共用同一份 OSV 查询）。这里只守桌面端**接线**：deps 处理器必须
 * 真把 runCveChecks 注入 scanDeps，dashboard 必须携带 cve.status，前端必须展示
 * unavailable 文案 —— 少任何一环，用户看到的「0 漏洞」就又变成没检测。
 */
import { describe, it, expect } from 'vitest';

describe('结构守卫 — P1-8 链路接线（防改回去）', () => {
  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');
  const electronDir = path.resolve(__dirname, '../../electron');
  const read = (rel: string): string => fs.readFileSync(path.join(electronDir, rel), 'utf-8');

  it('runDepsHandler 把 CVE 作为第 5 路并行检查', () => {
    const src = read('ipc/engines-deps.ts');
    // scanDeps 必须拿到真实 provider；不注入 = 依赖域永远报「未检测」
    expect(src).toContain('cveProvider: (nodes) => runCveChecks(nodes)');
    expect(src).toContain('report.cve'); // unavailable 时 status 仍要随行
    expect(src).toContain('cveCounts(report.cve)'); // dashboard patch 携带计数
    // 实现必须来自 @zh/pipeline（与 CLI 共用一份），不得回退到桌面端本地副本
    expect(src).toMatch(/import\s*\{[^}]*runCveChecks[^}]*\}\s*from\s*['"]@zh\/pipeline['"]/);
  });

  it('deps 域诊断归一化产出 CVE 条目；unavailable 不产条目', () => {
    const src = read('zh-diagnostics-engines.ts');
    expect(src).toContain('cve:${finding.name}@${finding.version}');
    expect(src).toContain('data.cve?.findings ?? []');
  });

  it('dashboard 契约携带 cve.status（unavailable 必须随行）', () => {
    const src = read('ipc/dashboard-state.ts');
    expect(src).toMatch(/cve\?\s*:\s*\{\s*status/);
  });

  it('前端依赖页必须有 CVE 卡片且引用 unavailable 文案', () => {
    const parts = fs.readFileSync(
      path.resolve(__dirname, '../pages/dependency-parts.tsx'),
      'utf-8',
    );
    // CVE 卡片下沉到 dependency-parts-cve.tsx：原路径必须保留 re-export（调用方接线不变）
    expect(parts).toContain('DependencyCveCard');
    const cveCard = fs.readFileSync(
      path.resolve(__dirname, '../pages/dependency-parts-cve.tsx'),
      'utf-8',
    );
    expect(cveCard).toContain("t('page.deps.cve.unavailable')");
    const page = fs.readFileSync(path.resolve(__dirname, '../pages/DependencyPage.tsx'), 'utf-8');
    expect(page).toContain('<DependencyCveCard report={report} />');
  });
});
