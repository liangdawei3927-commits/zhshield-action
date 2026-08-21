import { describe, it, expect } from 'vitest';
import {
  shouldAutoFix,
  countFixableIssues,
  buildFixPrompt,
  resolveOpenCodeBin,
  resolveOpenCodeModel,
  DEFAULT_OPENCODE_MODEL,
} from '../../electron/ai-auto-fix';
import type { DiagnosticsReport } from '../../electron/zh-diagnostics';

function makeReport(
  summary: { total: number; error: number; warning: number; info: number },
  issues: DiagnosticsReport['issues'] = [],
): DiagnosticsReport {
  return {
    version: '1.0',
    project: { path: '/proj', name: 'proj' },
    generatedAt: '2026-07-31T00:00:00.000Z',
    summary,
    issues,
    files: [],
  };
}

function entry(ruleId: string, severity: 'error' | 'warning' | 'info', source: 'guard' | 'inspect' | 'refactor'): DiagnosticsReport['issues'][number] {
  return {
    ruleId,
    severity,
    category: 'quality',
    message: `${ruleId} message`,
    file: 'src/a.ts',
    autoFixable: false,
    source,
    fingerprint: `${ruleId}:src/a.ts:1`,
  };
}

const inspectError = entry('i/err', 'error', 'inspect');
const inspectWarning = entry('i/warn', 'warning', 'inspect');
const guardError = entry('g/err', 'error', 'guard');
const guardWarning = entry('g/warn', 'warning', 'guard');

describe('shouldAutoFix', () => {
  it('巡检（inspect）有 error 时触发', () => {
    expect(shouldAutoFix(makeReport({ total: 1, error: 1, warning: 0, info: 0 }, [inspectError]))).toBe(true);
  });

  it('巡检（inspect）有 warning 时触发', () => {
    expect(shouldAutoFix(makeReport({ total: 1, error: 0, warning: 1, info: 0 }, [inspectWarning]))).toBe(true);
  });

  it('门禁（guard/预防）有 error 或 warning 时不触发自动修复', () => {
    expect(shouldAutoFix(makeReport({ total: 1, error: 1, warning: 0, info: 0 }, [guardError]))).toBe(false);
    expect(shouldAutoFix(makeReport({ total: 1, error: 0, warning: 1, info: 0 }, [guardWarning]))).toBe(false);
  });

  it('guard 与 inspect 混合时，只要有非 guard 的 error/warning 就触发', () => {
    const mixed = [guardError, inspectWarning];
    expect(shouldAutoFix(makeReport({ total: 2, error: 1, warning: 1, info: 0 }, mixed))).toBe(true);
  });

  it('只有 info 或 0 问题时不触发', () => {
    expect(shouldAutoFix(makeReport({ total: 1, error: 0, warning: 0, info: 1 }, []))).toBe(false);
    expect(shouldAutoFix(makeReport({ total: 0, error: 0, warning: 0, info: 0 }, []))).toBe(false);
  });

  it('旧格式诊断文件（无 issues 明细）回退到 summary 计数判断', () => {
    const legacy = makeReport({ total: 1, error: 1, warning: 0, info: 0 }) as DiagnosticsReport & {
      issues?: unknown;
    };
    delete legacy.issues;
    expect(shouldAutoFix(legacy as unknown as Parameters<typeof shouldAutoFix>[0])).toBe(true);
    legacy.summary = { total: 1, error: 0, warning: 0, info: 1 };
    expect(shouldAutoFix(legacy as unknown as Parameters<typeof shouldAutoFix>[0])).toBe(false);
  });
});

describe('countFixableIssues', () => {
  it('只统计非 guard 来源的 error/warning', () => {
    const mixed = [guardError, guardWarning, inspectError, inspectWarning];
    const { error, warning } = countFixableIssues(
      makeReport({ total: 4, error: 2, warning: 2, info: 0 }, mixed),
    );
    expect(error).toBe(1);
    expect(warning).toBe(1);
  });

  it('无 issues 明细时回退到 summary 计数', () => {
    const { error, warning } = countFixableIssues({ summary: { error: 3, warning: 2 } });
    expect(error).toBe(3);
    expect(warning).toBe(2);
  });
});

describe('buildFixPrompt', () => {
  it('生成的 prompt 包含诊断文件路径和修复指令', () => {
    const prompt = buildFixPrompt('/proj');
    expect(prompt).toContain('/proj/.zhshield/diagnostics/latest.json');
    expect(prompt).toContain('修复');
    expect(prompt).toContain('error');
  });

  it('prompt 提示无 file 的条目属于工具配置类问题，应检查配置而非空转', () => {
    const prompt = buildFixPrompt('/proj');
    expect(prompt).toContain('没有 file');
    expect(prompt).toContain('配置');
  });

  it('prompt 明确指示跳过 source 为 guard（门禁/预防）的条目', () => {
    const prompt = buildFixPrompt('/proj');
    expect(prompt).toContain('"guard"');
    expect(prompt).toContain('跳过');
  });
});

describe('resolveOpenCodeBin', () => {
  const candidates = (paths: string[]): Array<{ path: string; executable: boolean }> =>
    paths.map((path) => ({ path, executable: true }));

  it('环境变量指定的可执行路径优先', () => {
    expect(resolveOpenCodeBin('/custom/opencode', candidates(['/usr/local/bin/opencode', '/custom/opencode']))).toBe(
      '/custom/opencode',
    );
  });

  it('环境变量不可执行时回退到候选列表第一个可执行项', () => {
    expect(
      resolveOpenCodeBin('/missing/opencode', [
        { path: '/usr/local/bin/opencode', executable: true },
        { path: '/opt/bin/opencode', executable: true },
      ]),
    ).toBe('/usr/local/bin/opencode');
  });

  it('无任何可执行项时返回 null', () => {
    expect(resolveOpenCodeBin('OPENCODE_BIN_TEST', [{ path: '/bin/opencode', executable: false }])).toBeNull();
  });
});

describe('resolveOpenCodeModel', () => {
  it('环境变量指定模型时优先', () => {
    expect(resolveOpenCodeModel('google/gemini-2.5-flash')).toBe('google/gemini-2.5-flash');
  });

  it('环境变量为空串/undefined 时回退默认模型', () => {
    expect(resolveOpenCodeModel('')).toBe(DEFAULT_OPENCODE_MODEL);
    expect(resolveOpenCodeModel(undefined)).toBe(DEFAULT_OPENCODE_MODEL);
  });

  it('默认模型是 CLI 子进程可用的免费模型（非会话专用路由）', () => {
    expect(DEFAULT_OPENCODE_MODEL).toBe('opencode/deepseek-v4-flash-free');
  });
});
