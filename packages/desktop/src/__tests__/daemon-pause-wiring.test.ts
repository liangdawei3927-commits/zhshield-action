/**
 * 常驻守护（哨兵监控 / 备份中心）的「停止」接线守卫（2026-10-25）
 *
 * 用户诉求：「哨兵监控和备份中心也需要添加暂停功能，不然想停止，停止不了呀」。
 *
 * 此前 8 个按需检查域的停止走任务中心（TaskManager.cancel）；哨兵与备份是**常驻
 * 守护**，压根不进任务中心，所以「点下去停不了」在这两个域是必然的。本测试锁
 * 两端接线：
 *
 * 1. **哨兵**：`sentinel:stopMonitoring` 通道存在且真的停监视器（不是只改前端状态）；
 *    preload / engineApi / 页面三层都接上；
 * 2. **备份**：`backup:cancel` 通道存在，且 `backup:execute` **真的把 abortSignal
 *    传给 orchestrator** —— kernel 全链路早已支持取消，缺的只是这个实参（此前
 *    从未有调用方传过，等于能力齐备、接缝断裂）；
 * 3. 两个域的主按钮都把 onCancel 交给 DomainActionButton（hover 出「停止」）。
 *
 * 另有一条纯函数测试：`applyMonitoringStop`（哨兵监控表的移除语义）。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyMonitoringStop } from '../../electron/sentinel-monitoring';

// 包根：本测试同时读 src/ 与 electron/ 两侧，路径一律从包根起算
const SRC = resolve(__dirname, '../..');
const read = (rel: string): string => readFileSync(resolve(SRC, rel), 'utf8');

describe('哨兵：停止监控的通道与接线', () => {
  it('主进程注册了 sentinel:stopMonitoring，且真的停掉监视器', () => {
    const src = read('electron/ipc/sentinel.ts');
    expect(src).toContain("'sentinel:stopMonitoring'");
    // 只改前端状态不算停：必须真的停掉三个监视器（file/log/process）。
    // 断言落在**停止函数体内**而不是整文件 —— 全文件级断言会被别处的调用骗绿
    // （setEnabled(false) 里也有一次 stopAllMonitoring）。
    const fn = src.slice(
      src.indexOf('async function stopMonitoringForProject'),
      src.indexOf('function registerMonitoringStop'),
    );
    expect(fn, '停止函数没有真的停监视器').toMatch(/stopAllMonitoring\(\)/);
  });

  it('preload 暴露 stopMonitoring', () => {
    expect(read('electron/preload.ts')).toContain("'sentinel:stopMonitoring'");
  });

  it('渲染层 API 导出 stopSentinelMonitoring', () => {
    const src = read('src/services/engineApi-sentinel.ts');
    expect(src).toMatch(/export (async )?function stopSentinelMonitoring/);
  });

  it('类型声明补上 stopMonitoring（漏声明 = 渲染层 TS 用不了）', () => {
    const src = read('src/types/electron.d.ts');
    const block = src.slice(src.indexOf('interface SentinelAPI'));
    expect(block.slice(0, 800)).toMatch(/stopMonitoring/);
  });

  it('哨兵页空态与详情页的主按钮都传了 onCancel', () => {
    const src = read('src/pages/SentinelPage.tsx');
    // 空态（DomainEmptyView）与详情（DomainActionButton）各一处，缺一处就等于
    // 「这个状态下还是停不了」
    const cancels = src.match(/onCancel=\{/g) ?? [];
    expect(cancels.length, '哨兵页的停止入口不全').toBeGreaterThanOrEqual(2);
  });

  /**
   * 形状检查抓不住"接了 onCancel 但按钮根本没进忙态"（2026-10-26 实锤）：
   * 主页当时写的是 `loading={props.loading}` —— 漏了 monitoring，于是按钮不忙、
   * `stoppable=false`，hover 不出「停止」，可源码里 `onCancel={` 照样有 ⇒ 本用例
   * 一直绿。**行为级判定在 sentinel-stop-affordance.test.tsx**（渲染出 DOM 后
   * 断言 data-stoppable / data-action-text="stop" / 未禁用）。
   *
   * 这里补一条"同一判定源"的结构约束：两视图不许各拼各的忙态。
   */
  it('哨兵页两个视图的忙态来自同一判定源（不许各拼各的）', () => {
    const src = read('src/pages/SentinelPage.tsx');
    const calls = src.match(/deriveSentinelActionState\(/g) ?? [];
    expect(calls.length, '忙态判定出现多个调用点 ⇒ 主页与详情页可能又分叉').toBe(1);
    expect(src, '主页又写回了漏 monitoring 的老写法').not.toMatch(/loading=\{props\.loading\}/);
    expect(src, '详情页又就地拼了 monitoring || loading').not.toMatch(
      /loading=\{monitoring \|\| loading\}/,
    );
  });
});

describe('哨兵：监控表移除语义（纯函数）', () => {
  it('移除已监控项目，返回是否命中与剩余项', () => {
    const table = new Map([
      ['a', '/a'],
      ['b', '/b'],
    ]);
    const out = applyMonitoringStop(table, 'a');
    expect(out.stopped).toBe(true);
    expect(out.remaining).toEqual([['b', '/b']]);
    expect(table.has('a')).toBe(false);
  });

  it('移除最后一项：剩余为空 ⇒ 调用方据此全停监视器', () => {
    const table = new Map([['a', '/a']]);
    const out = applyMonitoringStop(table, 'a');
    expect(out.stopped).toBe(true);
    expect(out.remaining).toEqual([]);
  });

  it('未监控的项目：stopped=false 且不改动表（避免误报"已停止"）', () => {
    const table = new Map([['a', '/a']]);
    const out = applyMonitoringStop(table, 'zzz');
    expect(out.stopped).toBe(false);
    expect(out.remaining).toEqual([['a', '/a']]);
  });
});

describe('备份：取消通道与 abortSignal 接缝', () => {
  it('主进程注册了 backup:cancel', () => {
    expect(read('electron/ipc/backup.ts')).toContain("'backup:cancel'");
  });

  it('backup:execute 真的把 abortSignal 传给 orchestrator（此前从未传 ⇒ 停不了）', () => {
    const src = read('electron/ipc/backup.ts');
    const block = src.slice(src.indexOf("'backup:execute'"));
    expect(block.slice(0, 1200)).toMatch(/abortSignal/);
  });

  it('preload 暴露 cancelBackup', () => {
    expect(read('electron/preload.ts')).toContain("'backup:cancel'");
  });

  it('渲染层 API 导出 cancelBackup', () => {
    const src = read('src/services/engineApi-backup.ts');
    expect(src).toMatch(/export (async )?function cancelBackup/);
  });

  it('备份页详情与空态的主按钮都传了 onCancel', () => {
    const page = read('src/pages/BackupPage.tsx');
    expect(page).toMatch(/onCancel=\{/);
    expect(read('src/pages/backup-empty-state.tsx')).toMatch(/onCancel=\{/);
  });
});
