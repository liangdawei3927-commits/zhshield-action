/**
 * 「门禁结论」区块的渲染守卫。
 *
 * 锁四件事（每一条都对应一次实测踩坑）：
 * 1) `total === 0` 必须说「无门禁」，**不能**渲染成「门禁通过」——那是把「没有规则」
 *    伪装成「全部达标」，比不显示更坏；
 * 2) `undetermined` 单独一色、文案带原因，**既不能被读成通过、也不能被读成未达标**
 *    （缺数据源 ≠ 代码越界；只测一半会让"缺覆盖率报告"被画成红色未通过）；
 * 3) 非阻断条目失败时标注「不阻断」，避免用户以为体检被拦；
 * 4) 任何情况下不出现 undefined / NaN。
 *
 * 另有一组双向自证：有未达标条目时**必须**出现红色结论、全通过时**必须**不出现
 * 「未通过」字样 —— 只测一半会让分支永远不被执行。
 */

import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../i18n';
import { ProjectGatesSection } from '../pages/report-gates';
import type { ProjectGateItemData, ProjectGateReportData } from '../types/electron';

vi.stubGlobal('navigator', { language: 'zh-Hans' });

const item = (patch: Partial<ProjectGateItemData>): ProjectGateItemData => ({
  ruleId: 'guard.block.official.health-score',
  metric: 'health-score',
  status: 'passed',
  blocking: true,
  threshold: 70,
  actual: 82,
  unit: 'score',
  message: '健康分=82 score，阈值 70 score — 达标',
  ...patch,
});

const report = (patch: Partial<ProjectGateReportData>): ProjectGateReportData => ({
  total: 1,
  passed: 1,
  failed: 0,
  undetermined: 0,
  blockingFailed: 0,
  blockingUndetermined: 0,
  ok: true,
  complete: true,
  items: [item({})],
  ...patch,
});

const render = (gates?: ProjectGateReportData) =>
  renderToStaticMarkup(
    <I18nProvider>
      <ProjectGatesSection gates={gates} />
    </I18nProvider>,
  );

describe('门禁结论区块', () => {
  it('GIVEN 没有门禁规则 WHEN 渲染 THEN 说明「无门禁」，不显示通过', () => {
    const html = render(report({ total: 0, passed: 0, items: [] }));

    expect(html).toContain('无门禁');
    expect(html).toContain('不代表门禁全部通过');
    expect(html).not.toContain('门禁通过<');
  });

  it('GIVEN 未取到总览（gates 为 undefined）WHEN 渲染 THEN 走同一空态，不抛错', () => {
    expect(render(undefined)).toContain('无门禁');
  });

  it('GIVEN 全部达标 WHEN 渲染 THEN 显示通过且带逐条结论', () => {
    const html = render(report({}));

    expect(html).toContain('门禁通过');
    expect(html).toContain('guard.block.official.health-score');
    expect(html).toContain('健康分=82');
  });

  it('GIVEN 有一条未达标 WHEN 渲染 THEN 显示未通过（正向自证的另一半）', () => {
    const html = render(
      report({
        passed: 0,
        failed: 1,
        blockingFailed: 1,
        ok: false,
        complete: true,
        items: [
          item({
            status: 'failed',
            metric: 'coverage',
            actual: 63,
            message: '测试覆盖率=63 percent，阈值 80 percent — 未达标',
          }),
        ],
      }),
    );

    expect(html).toContain('门禁未通过');
    expect(html).toContain('未达标 1');
  });

  it('GIVEN 未判定 WHEN 渲染 THEN 单独计数并给出原因，不算通过也不算未达标', () => {
    const html = render(
      report({
        passed: 0,
        undetermined: 1,
        blockingUndetermined: 1,
        ok: false,
        complete: false,
        items: [
          item({
            status: 'undetermined',
            message: '无法确定 diff 覆盖率基线（缺覆盖率报告）',
          }),
        ],
      }),
    );

    expect(html).toContain('未判定 1');
    expect(html).toContain('无法确定 diff 覆盖率基线');
    // 双向自证：缺数据源不是代码越界，绝不能画成红色「未通过」；
    // 但同时必须明确它不等于通过（原实现只满足后者，把前者丢了）。
    expect(html).toContain('门禁未判定');
    expect(html).not.toContain('门禁通过');
    expect(html).not.toContain('门禁未通过');
  });

  it('GIVEN 未判定与未达标同时存在 WHEN 渲染 THEN 未达标优先，仍判未通过', () => {
    const html = render(
      report({
        total: 2,
        passed: 0,
        failed: 1,
        undetermined: 1,
        blockingFailed: 1,
        blockingUndetermined: 1,
        ok: false,
        complete: false,
        items: [
          item({
            status: 'failed',
            metric: 'coverage',
            actual: 63,
            message: '测试覆盖率=63 percent，阈值 80 percent — 未达标',
          }),
          item({
            ruleId: 'guard.block.official.test-coverage',
            status: 'undetermined',
            message: '未找到含行级数据的覆盖率报告',
          }),
        ],
      }),
    );

    expect(html).toContain('门禁未通过');
    expect(html).toContain('未达标 1');
    expect(html).toContain('未判定 1');
  });

  it('GIVEN 非阻断门禁未判定 WHEN 渲染 THEN 提示缺数据源，不拉红结论', () => {
    const html = render(
      report({
        passed: 0,
        undetermined: 1,
        blockingUndetermined: 0,
        ok: true,
        complete: false,
        items: [
          item({
            blocking: false,
            status: 'undetermined',
            message: '健康分不可用：当前入口不计算聚合评分',
          }),
        ],
      }),
    );

    expect(html).toContain('门禁未判定');
    expect(html).toContain('不阻断');
    // 负向断言：旧实现按 `ok` 判，此例 ok=true ⇒ 会被渲染成「门禁通过」，
    // 把缺数据源粉饰成达标。必须靠这条拦住回归。
    expect(html).not.toContain('门禁未通过');
    expect(html).not.toContain('门禁通过<');
  });

  it('GIVEN 非阻断门禁失败 WHEN 渲染 THEN 标注「不阻断」，不拉红结论', () => {
    const html = render(
      report({
        passed: 0,
        failed: 1,
        blockingFailed: 0,
        ok: true,
        items: [item({ blocking: false, status: 'failed', message: '覆盖率=40 — 未达标' })],
      }),
    );

    expect(html).toContain('不阻断');
    expect(html).toContain('门禁通过');
  });

  it('GIVEN 任意组合 WHEN 渲染 THEN 不出现 undefined / NaN', () => {
    const html = render(
      report({
        items: [
          item({ status: 'undetermined', actual: undefined, threshold: undefined, unit: undefined }),
          item({ ruleId: 'guard.block.official.test-coverage', metric: 'coverage' }),
        ],
      }),
    );

    expect(html).not.toContain('undefined');
    expect(html).not.toContain('NaN');
  });
});
