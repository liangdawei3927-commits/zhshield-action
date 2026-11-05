import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PipelineRunner } from '../pipeline-runner';

const TEMPLATES_DIR = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'kernel',
  'src',
  'sop',
  'presets',
  'sop-templates',
);

describe('PipelineRunner — SOP 规则加载与盲检降级', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('configDir 指向内置模板时 loadSopRules 返回 >0', async () => {
    const runner = new PipelineRunner(process.cwd(), { configDir: TEMPLATES_DIR });
    const count = await runner.loadSopRules();
    expect(count).toBeGreaterThan(0);
    await runner.destroy();
  });

  it('configDir 指向空目录时 loadSopRules 返回 0 并输出降级错误日志', async () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhshield-empty-sop-'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const runner = new PipelineRunner(process.cwd(), { configDir: emptyDir });
    const count = await runner.loadSopRules();
    expect(count).toBe(0);
    const messages = errorSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(messages).toContain('降级');
    expect(messages).toContain('0 条');
    await runner.destroy();
    fs.rmSync(emptyDir, { recursive: true, force: true });
  });

  /**
   * 《07》O6：内置模板里存在没有 SOP 求值入口的规则（evolve / sentinel），
   * 加载后必须把接线审计结果打出来。静默吞掉这些规则 = 用户看到「N 条规则参与判定」，
   * 实际有相当一部分永远零产出。
   */
  it('loadSopRules 载入内置模板后输出 orphan 接线审计告警', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runner = new PipelineRunner(process.cwd(), { configDir: TEMPLATES_DIR });
    await runner.loadSopRules();
    const messages = warnSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(messages).toContain('接线审计');
    expect(messages).toContain('orphan');
    expect(messages).toContain('domain-not-served');
    await runner.destroy();
  });
});
