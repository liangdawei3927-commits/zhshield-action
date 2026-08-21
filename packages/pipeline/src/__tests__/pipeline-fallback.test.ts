import { describe, it, expect } from 'vitest';
import path from 'path';
import { PipelineRunner } from '../pipeline-runner';

const SCAN_TARGET = path.resolve(__dirname, '..');

/**
 * 降级流与异常处理测试
 *
 * 验证 pipeline-runner.ts 中 catch 块（toMessage）的正确性：
 * - Guard 引擎抛 Error 时，流水线降级到 guard 阶段并返回错误信息
 * - Guard 引擎抛非 Error 值时，toMessage 安全降级（String(err) 分支）
 * - Guard 阻断（ok=false）时，流水线终止在 guard 阶段
 */
describe('PipelineRunner — 降级流与异常处理', () => {
  let runner: PipelineRunner;

  /** 用 Object.create 保留原型链，覆盖 run 方法为抛异常的 mock */
  function injectFailingGuard(throwValue: unknown): void {
    const mock = Object.create(runner.guardEngine) as typeof runner.guardEngine;
    mock.run = async () => {
      throw throwValue;
    };
    runner.guardEngine = mock;
  }

  it('Guard 引擎抛 Error 时，全流水线降级到 guard 阶段', async () => {
    runner = new PipelineRunner(SCAN_TARGET);
    injectFailingGuard(new Error('Guard 引擎模拟崩溃'));

    const report = await runner.runFullPipeline({ dryRun: true });

    expect(report.passed).toBe(false);
    expect(report.stage).toBe('guard');
    expect(report.error).toContain('Guard 引擎模拟崩溃');
    expect(report.guard).toBeNull();
    expect(report.inspect).toBeNull();
    await runner.destroy();
  });

  it('Guard 引擎抛非 Error 值（字符串）时，toMessage 安全降级', async () => {
    runner = new PipelineRunner(SCAN_TARGET);
    injectFailingGuard('字符串类型异常');

    const report = await runner.runFullPipeline({ dryRun: true });

    expect(report.passed).toBe(false);
    expect(report.stage).toBe('guard');
    // toMessage 对非 Error 值走 String(err) 分支
    expect(report.error).toContain('字符串类型异常');
    await runner.destroy();
  });

  it('Guard 引擎抛对象类型异常时，toMessage 降级为 [object Object]', async () => {
    runner = new PipelineRunner(SCAN_TARGET);
    injectFailingGuard({ code: 500, reason: '对象异常' });

    const report = await runner.runFullPipeline({ dryRun: true });

    expect(report.passed).toBe(false);
    expect(report.stage).toBe('guard');
    // 非 Error 对象走 String() → "[object Object]"
    expect(report.error).toBeDefined();
    expect(typeof report.error).toBe('string');
    await runner.destroy();
  });

  it('多次调用 runFullPipeline 不会累积状态', async () => {
    runner = new PipelineRunner(SCAN_TARGET);
    injectFailingGuard(new Error('第一次崩溃'));

    const r1 = await runner.runFullPipeline({ dryRun: true });
    expect(r1.passed).toBe(false);

    // 第二次调用应独立返回，不因前次失败而影响
    const r2 = await runner.runFullPipeline({ dryRun: true });
    expect(r2.passed).toBe(false);
    expect(r2.stage).toBe('guard');
    expect(r2.error).toContain('第一次崩溃');

    await runner.destroy();
  });
});
