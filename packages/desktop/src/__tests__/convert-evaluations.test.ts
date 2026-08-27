import { describe, expect, it } from 'vitest';
import {
  convertInspectEvaluations,
  convertGuardEvaluations,
} from '../../electron/ipc/score-converters';

/**
 * 回归测试：SOP 体检评分转换的两条历史 bug。
 * - Bug 1：passed/skipped 的 inspect 评估被当成 issue 扣分（全 passed 健康项目反而 41 分）
 * - Bug 3：test/dependency 标签被映射成 'testing'，匹配不到任何维度而整体消失
 */

type InspectEval = {
  status?: string;
  rule?: { severity?: string; tags?: string[] };
};

describe('convertInspectEvaluations', () => {
  it('Bug1: 过滤 passed 评估，健康项目不扣分', () => {
    const evals: InspectEval[] = [
      { status: 'passed', rule: { severity: 'error', tags: ['security'] } },
      { status: 'passed', rule: { severity: 'warning', tags: ['quality'] } },
      { status: 'passed', rule: { severity: 'info', tags: ['documentation'] } },
    ];
    expect(convertInspectEvaluations(evals)).toEqual([]);
  });

  it('Bug1: 过滤 skipped 评估（规则不适用，非真实问题）', () => {
    const evals: InspectEval[] = [
      { status: 'skipped', rule: { severity: 'error', tags: ['security'] } },
    ];
    expect(convertInspectEvaluations(evals)).toEqual([]);
  });

  it('Bug1: failed 评估保留并正确映射 severity 与 category', () => {
    const evals: InspectEval[] = [
      { status: 'failed', rule: { severity: 'high', tags: ['security'] } },
      { status: 'failed', rule: { severity: 'medium', tags: ['architecture'] } },
    ];
    const out = convertInspectEvaluations(evals);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ severity: 'error', category: 'security' });
    expect(out[1]).toEqual({ severity: 'warning', category: 'architecture' });
  });

  it('Bug3: dependency 标签 → category "dependency"（落入 dependencies 维度）', () => {
    const evals: InspectEval[] = [
      { status: 'failed', rule: { severity: 'medium', tags: ['dependency'] } },
    ];
    const out = convertInspectEvaluations(evals);
    expect(out).toHaveLength(1);
    expect(out[0].category).toBe('dependency');
  });

  it('Bug3: test 标签 → category "test"（落入 dependencies 维度）', () => {
    const evals: InspectEval[] = [
      { status: 'failed', rule: { severity: 'low', tags: ['test'] } },
    ];
    const out = convertInspectEvaluations(evals);
    expect(out).toHaveLength(1);
    expect(out[0].category).toBe('test');
  });

  it('Bug3: 曾错误的 category 值 "testing" 不再产生', () => {
    const evals: InspectEval[] = [
      { status: 'failed', rule: { severity: 'medium', tags: ['dependency'] } },
      { status: 'failed', rule: { severity: 'low', tags: ['test'] } },
    ];
    const out = convertInspectEvaluations(evals);
    expect(out.some((i) => i.category === 'testing')).toBe(false);
  });
});

describe('convertGuardEvaluations', () => {
  it('passed 不计入失败/阻塞', () => {
    const evals = [
      { status: 'passed', rule: { severity: 'high' } },
      { status: 'failed', rule: { severity: 'critical' } },
    ];
    const out = convertGuardEvaluations(evals);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ severity: 'error', status: 'passed', blocking: false });
    expect(out[1]).toEqual({ severity: 'error', status: 'failed', blocking: true });
  });

  it('skipped 评估被过滤，不产生输出条目（工具未安装不应扣分）', () => {
    const evals = [
      { status: 'passed', rule: { severity: 'high' } },
      { status: 'skipped', rule: { severity: 'medium' } },
      { status: 'skipped', rule: { severity: 'critical' } },
    ];
    const out = convertGuardEvaluations(evals);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ severity: 'error', status: 'passed', blocking: false });
  });

  it('全 skipped 输入返回空数组', () => {
    const evals = [
      { status: 'skipped', rule: { severity: 'high' } },
      { status: 'skipped', rule: { severity: 'medium' } },
    ];
    expect(convertGuardEvaluations(evals)).toEqual([]);
  });

  it('error 状态保留并映射', () => {
    const evals = [
      { status: 'error', rule: { severity: 'low' } },
    ];
    const out = convertGuardEvaluations(evals);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ severity: 'info', status: 'error', blocking: false });
  });
});
