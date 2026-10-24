/**
 * 报告中心「评分总览」与分类页同源的接缝测试。
 *
 * 背景（2026-10-24 P0，用户实测）：报告中心卡片显示门禁 100 分，点进分类页却是 92.9，
 * 其它卡也对不上。根因是**两条取数链不同源** —— 卡片读 scores 表里最近一条历史汇总
 * 记录（时点快照），分类页走 `engine:getDomainScore` 实时重算。
 *
 * 本测试锁的是「结构性不可能漂移」，不是锁某个具体分数：
 * 只要两处继续共用 `assembleHealthInputs` + `buildHealthDimensions`，
 * 卡片上的数与点进去看到的数就是同一个数。
 *
 * 每条断言都做过反向自证（把源码改坏 → 必须变红）：
 * - 去掉 `assembleHealthInputs` → 同源断言红；
 * - 把 `computeOverallSnapshot` 换成 `scoring.calculate` → 不落库断言红（会污染历史）；
 * - 让 `computePipelineHealthScore` 回到消费内存报告 → 写分点合并断言红。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { overviewRowInput } from '../pages/category-score-logic';
import type { DimensionEntry } from '../pages/category-score-logic';

const ROOT = new URL('../../', import.meta.url);
const readSrc = (rel: string): string => readFileSync(new URL(rel, ROOT), 'utf-8');

/** 截取某个导出函数的函数体（到下一个顶层 export 为止），避免被别处的同名字符串骗绿 */
function bodyOf(src: string, signature: string): string {
  const start = src.indexOf(signature);
  if (start < 0) throw new Error(`源码中未找到 ${signature}（函数被改名或删除）`);
  const rest = src.slice(start);
  const end = rest.indexOf('\nexport ');
  return end < 0 ? rest : rest.slice(0, end);
}

const scoringSrc = readSrc('electron/ipc/engines-scoring.ts');
const enginesSrc = readSrc('electron/ipc/engines.ts');
const preloadSrc = readSrc('electron/preload.ts');

describe('engine:getHealthOverview（总览实时视图）', () => {
  const overviewBody = bodyOf(scoringSrc, 'export async function getHealthOverviewHandler');

  it('与分类页共用 assembleHealthInputs（同一份输入组装）', () => {
    const domainBody = bodyOf(scoringSrc, 'export async function getDomainScoreHandler');
    // 总览与写分点已收敛到唯一 helper：两者只经 collectScoringInputs 取数，
    // 不再各自复制一份 assembleHealthInputs 调用（复制品一旦分叉就会写两个分）
    expect(overviewBody).toMatch(/collectScoringInputs\(/);
    const collectBody = bodyOf(scoringSrc, 'async function collectScoringInputs');
    expect(collectBody).toMatch(/assembleHealthInputs\(/);
    // 分类页实时评分仍用同一个组装函数（同一输入形状）
    expect(domainBody).toMatch(/assembleHealthInputs\(/);
  });

  it('与分类页共用 buildHealthDimensions（同一套算分）', () => {
    const domainBody = bodyOf(scoringSrc, 'export async function getDomainScoreHandler');
    expect(overviewBody).toMatch(/buildHealthDimensions\(/);
    expect(domainBody).toMatch(/buildHealthDimensions\(/);
  });

  it('一次组装取满十维，不是循环调十次单维接口（十张卡必须同一时刻）', () => {
    expect(overviewBody).not.toMatch(/for\s*\(/);
    expect(overviewBody).not.toMatch(/getDomainScoreHandler\(/);
  });

  it('只读不落库：不得调用 scoring.calculate（否则打开页面=一次评估，污染历史曲线）', () => {
    expect(overviewBody).toMatch(/computeOverallSnapshot\(/);
    expect(overviewBody).not.toMatch(/\.calculate\(/);
  });

  it('IPC 已注册且 preload 已暴露（防「定义还在、线没接」）', () => {
    expect(enginesSrc).toMatch(/ipcMain\.handle\('engine:getHealthOverview'/);
    expect(enginesSrc).toMatch(/getHealthOverviewHandler,/);
    expect(preloadSrc).toMatch(/getHealthOverview: \(projectPath: string\)/);
  });
});

describe('两个写分点已合并为同一函数', () => {
  it('pipeline 写分不再消费内存报告，走与报告中心相同的汇总函数', () => {
    const pipelineBody = bodyOf(scoringSrc, 'export async function computePipelineHealthScore');
    expect(pipelineBody).toMatch(/summarizeAndPersistScore\(/);
    // 旧实现消费本次运行的 guard/inspect 结果 ⇒ 与磁盘快照能写出两个分
    expect(pipelineBody).not.toMatch(/resolved\./);
  });

  it('报告中心汇总与 pipeline 写分调用同一个函数', () => {
    const summaryBody = bodyOf(scoringSrc, 'export async function generateReportSummaryHandler');
    expect(summaryBody).toMatch(/summarizeAndPersistScore\(/);
  });
});

describe('overviewRowInput（实时总览 → 卡片行入参）', () => {
  const dim = (over: Partial<DimensionEntry>): DimensionEntry => ({
    name: 'quality',
    score: 80,
    weight: 0.1,
    status: 'scored',
    ...over,
  });

  it('数据时间取参与域里**最旧**的那个（最旧域决定总分可信度）', () => {
    const input = overviewRowInput({
      overall: 85,
      readAt: '2026-10-24T07:13:40.000Z',
      dimensions: [
        dim({ name: 'quality', generatedAt: '2026-10-24T07:00:00.000Z' }),
        dim({ name: 'gate', generatedAt: '2026-10-22T07:00:00.000Z' }),
      ],
    });
    expect(input.generatedAt).toBe('2026-10-22T07:00:00.000Z');
  });

  it('未检测（not-run）的域不进数据时间、也不进覆盖范围分子', () => {
    const input = overviewRowInput({
      overall: 85,
      readAt: '2026-10-24T07:13:40.000Z',
      dimensions: [
        dim({ name: 'quality', generatedAt: '2026-10-24T07:00:00.000Z' }),
        dim({ name: 'gate', status: 'not-run', generatedAt: '2026-10-01T00:00:00.000Z' }),
      ],
    });
    expect(input.generatedAt).toBe('2026-10-24T07:00:00.000Z');
    expect(input.overall.partial).toEqual({ run: 1, total: 2 });
  });

  it('全线无时间锚点时回退读取时刻（不拿 null 当时间）', () => {
    const input = overviewRowInput({
      overall: 85,
      readAt: '2026-10-24T07:13:40.000Z',
      dimensions: [dim({ generatedAt: null })],
    });
    expect(input.generatedAt).toBe('2026-10-24T07:13:40.000Z');
  });

  it('红线信息透传（被压制的总分必须说清为什么）', () => {
    const redLine = { capped: true, cap: 60, reasons: [{ kind: 'critical', count: 2 }] };
    const input = overviewRowInput({
      overall: 60,
      readAt: '2026-10-24T07:13:40.000Z',
      dimensions: [dim({})],
      redLine,
    });
    expect(input.overall.redLine).toEqual(redLine);
  });
});
