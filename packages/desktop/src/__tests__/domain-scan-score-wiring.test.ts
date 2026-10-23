/**
 * 「单域扫描后补记总分」接线守卫。
 *
 * 为什么用结构断言而不是行为测试：包装点在 IPC 注册行，跑起来要整个 Electron + 真库；
 * 而漏包一个的后果在界面上**完全看不出来** —— 只是那个域扫了永远不进总分历史，
 * 报告里少几条点，谁也不会发现。这正是「组件齐备、接缝断裂」的典型形态，
 * 只能靠接线清单钉死。
 *
 * 同时钉住两条反向约束：
 * - `runPipeline` 自带 recordPipelineScore，**不得**再包（否则一次扫描写两条总分）；
 * - 补记必须复用写分点 2/2，不得自己再算一遍（否则同一时刻写出两个分）。
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ENGINES = path.resolve(__dirname, '../../electron/ipc/engines.ts');

function source(): string {
  return fs.readFileSync(ENGINES, 'utf-8');
}

/** 截取某通道注册块：从该通道名到下一个 ipcMain.handle( */
function handlerBlock(src: string, channel: string): string {
  const start = src.indexOf(`'${channel}'`);
  expect(start, `未找到 ${channel} 的 IPC 注册`).toBeGreaterThan(-1);
  const next = src.indexOf('ipcMain.handle(', start + 1);
  return src.slice(start, next === -1 ? undefined : next);
}

/** 截取某函数体：从签名到指定的下一个锚点（锚点必须唯一，避免截进别的函数） */
function functionBody(src: string, signature: string, endMarker: string): string {
  const start = src.indexOf(signature);
  expect(start, `未找到 ${signature}`).toBeGreaterThan(-1);
  const end = src.indexOf(endMarker, start + signature.length);
  expect(end, `未找到 ${signature} 的结束锚点 ${endMarker}`).toBeGreaterThan(start);
  return src.slice(start, end);
}

/** recordDomainScanScore 的结束锚点就是紧随其后的 withDomainScore */
const RECORD_SCORE_BODY = {
  sig: 'async function recordDomainScanScore',
  end: 'async function withDomainScore',
} as const;

/** withDomainScore 的结束锚点是注册函数 */
const WITH_DOMAIN_SCORE_BODY = {
  sig: 'async function withDomainScore',
  end: 'export function registerEnginesIpc',
} as const;

/** 七个「只更新域快照、不写总分」的单域扫描 */
const DOMAIN_SCAN_CHANNELS = [
  'engine:runGuard',
  'engine:runSecurity',
  'engine:runGarbageScan',
  'engine:runPerformance',
  'engine:runRefactor',
  'engine:runDeps',
  'engine:runTechDebt',
] as const;

describe('单域扫描 → 总分补记', () => {
  it.each(DOMAIN_SCAN_CHANNELS)('%s 必须包 withDomainScore', (channel) => {
    expect(handlerBlock(source(), channel)).toContain('withDomainScore(');
  });

  it('检测器不会恒真：未包装的通道确实被判为未包装', () => {
    // 反证项。若这条红了，说明上面的 it.each 只是在读一个恒真的字符串匹配，
    // 「七个都包了」的结论不作数（形态 ⑩：判据本身不会红 = 假绿）。
    expect(handlerBlock(source(), 'engine:garbageClean')).not.toContain('withDomainScore(');
    expect(handlerBlock(source(), 'engine:runPipeline')).not.toContain('withDomainScore(');
  });

  it('engine:runPipeline 不得再包（自带 recordPipelineScore）', () => {
    const block = handlerBlock(source(), 'engine:runPipeline');
    expect(block).toContain('runPipelineHandler');
    expect(block, 'runPipeline 再包会一次扫描写两条总分').not.toContain('withDomainScore(');
  });

  it('补记复用写分点 2/2，不新开算分路径', () => {
    const body = functionBody(source(), RECORD_SCORE_BODY.sig, RECORD_SCORE_BODY.end);
    expect(body).toContain('generateReportSummaryHandler');
    // 出现这些 = 绕过汇总函数自己再算一遍，两条路径必然漂移
    expect(body).not.toContain('buildHealthDimensions');
    expect(body).not.toContain('scoring.calculate');
  });

  it('补记失败只 warn，不得让扫描抛错', () => {
    const body = functionBody(source(), RECORD_SCORE_BODY.sig, RECORD_SCORE_BODY.end);
    expect(body).toContain('catch');
    expect(body).toContain('console.warn');
  });

  it('包装顺序是「先扫描、后补记」，不得颠倒', () => {
    const body = functionBody(source(), WITH_DOMAIN_SCORE_BODY.sig, WITH_DOMAIN_SCORE_BODY.end);
    const runAt = body.indexOf('await run()');
    const scoreAt = body.indexOf('recordDomainScanScore');
    expect(runAt).toBeGreaterThan(-1);
    expect(scoreAt).toBeGreaterThan(runAt);
  });
});
