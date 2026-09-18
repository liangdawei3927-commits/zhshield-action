import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * 门禁入口「同源装配」结构性守卫（T13 口径统一）
 *
 * 背景：`runGuardJob`（门禁页）曾自建 GuardEngine 并自注册 6 个适配器，但**没有**
 * `useSopEngine` 连线 —— `GuardEngine.run()` 于是落到 runTraditional 分支读
 * `guard/config/checks.json`（4 项），而体检流水线的门禁阶段走 SOP 规则集。
 * 同一个「门禁」两套规则集，条目数与结论都不一致，而代码里看不出问题
 * （两边都"正常"，只是规则源不同）。
 *
 * 这类分叉无法靠单元测试发现（要跑起整个 Electron 才能观察），所以在这里用
 * 结构断言把它钉死：任务入口**不得**自建引擎，必须经装配工厂拿 runner。
 * 巡检单引擎通道（runInspect）同理不得复活 —— 它曾是与 SOP 并行的第二套规则集。
 */
const ELECTRON_DIR = path.resolve(__dirname, '../../electron');

function read(rel: string): string {
  return fs.readFileSync(path.join(ELECTRON_DIR, rel), 'utf-8');
}

describe('门禁 / 巡检入口 — 装配同源', () => {
  it('pipeline-jobs 不自建引擎（必须经 createLoadedRunner）', () => {
    const src = read('pipeline-jobs.ts');
    expect(src).toContain('createLoadedRunner');
    expect(src, '任务入口出现 new GuardEngine( → 规则集又将与流水线分叉').not.toContain(
      'new GuardEngine(',
    );
    expect(src, '任务入口出现 new InspectEngine( → 规则集又将与流水线分叉').not.toContain(
      'new InspectEngine(',
    );
    expect(src, '任务入口不得自注册适配器（装配归 PipelineRunner）').not.toContain(
      'registerAdapter(',
    );
  });

  it('巡检单引擎通道不得复活（渲染层无调用方，会制造第三份规则集）', () => {
    // 断言「接线形态」而非裸名字：文档注释里提到历史实现是允许的，
    // 真正要拦的是定义与分派重新出现。
    expect(read('pipeline-jobs.ts'), '巡检任务定义不得复活').not.toMatch(
      /export async function runInspectJob\b/,
    );
    expect(read('pipeline-worker.ts'), 'worker 不应再分派 runInspect').not.toMatch(
      /case 'runInspect':/,
    );
    expect(read('pipeline-protocol.ts'), '协议不应再有 runInspect 消息').not.toMatch(
      /type: 'runInspect'/,
    );
    expect(read('task-manager.ts'), '不应再有巡检 worker 分派器').not.toContain(
      'runInspectInWorker',
    );
    expect(read('task-manager.ts'), "TaskKind 不应再含 'inspect'").not.toMatch(/\|\s*'inspect'/);
  });

  it('流水线与门禁页共用同一个装配工厂与规则装载顺序', () => {
    const worker = read('pipeline-worker.ts');
    const factory = read('pipeline-runner-factory.ts');
    expect(worker).toContain("from './pipeline-runner-factory'");
    // 规则装载只允许出现在工厂里：任何入口自己 loadSopRules 都会重新造出分叉
    expect(worker).not.toContain('loadSopRules(');
    expect(factory).toContain('loadSopRules()');
    expect(factory, '必须同时合并云同步规则，否则内置口径 ≠ 云端口径').toContain(
      'loadSopRulesFromCache',
    );
  });
});
