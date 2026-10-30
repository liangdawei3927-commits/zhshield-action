import { describe, it, expect } from 'vitest';
import { buildFindings } from '../machine-formatters';

// GuardReport → Finding 的归一是门禁阻断判断与 SARIF 输出的共同上游：
// passed 检查若误入 findings 会让 CI 面板充满噪声；违规明细若丢失位置/建议，
// 开发者在 GitHub 上只能看到「有错」而看不到「错在哪、怎么修」。

/** 构造 GuardReport 最小形态（buildFindings 的类型守卫只认 results 数组 + summary） */
function makeGuardReport(results: unknown[]) {
  const failed = results.filter((r) => (r as { status: string }).status !== 'passed').length;
  return {
    ok: failed === 0,
    mode: 'guard',
    target: '/proj',
    timestamp: new Date(),
    results,
    summary: { total: results.length, passed: results.length - failed, failed },
  };
}

describe('buildFindings — GuardReport 归一', () => {
  it('passed 的检查不产出 finding——SARIF 噪声会淹没真正需要关注的失败项', () => {
    const report = makeGuardReport([
      { checkId: 'chk.a', status: 'passed', severity: 'error', message: '通过' },
      { checkId: 'chk.b', status: 'passed', severity: 'info', message: '通过' },
    ]);
    expect(buildFindings(report)).toHaveLength(0);
  });

  it('skipped（让位：后置门禁由其它阶段判定）不产出 finding——它不是缺陷', () => {
    const report = makeGuardReport([
      {
        checkId: 'guard.block.official.health-score',
        status: 'skipped',
        severity: 'warning',
        message: '后置门禁规则：由扫描后门禁阶段按「health-score」判定，引擎内不求值',
      },
      {
        checkId: 'guard.block.official.test-coverage',
        status: 'skipped',
        severity: 'warning',
        message: '后置门禁规则：由扫描后门禁阶段按「coverage」判定，引擎内不求值',
      },
    ]);
    expect(buildFindings(report)).toHaveLength(0);
  });

  it('降级跳过（warning + degraded）仍产出 finding——未检测 ≠ 通过，不能被让位豁免吞掉', () => {
    const report = makeGuardReport([
      {
        checkId: 'guard.block.official.typescript-error',
        status: 'warning',
        severity: 'warning',
        degraded: true,
        message: '工具 tsc 错误: 依赖未安装',
      },
    ]);
    expect(buildFindings(report)).toHaveLength(1);
  });

  it('带 violations 明细的失败检查逐条展开，每条保留位置与修复建议', () => {
    const report = makeGuardReport([
      {
        checkId: 'chk.secret',
        status: 'failed',
        severity: 'error',
        message: '存在硬编码密钥',
        details: {
          violations: [
            {
              ruleId: 'secret.hardcoded-key',
              severity: 'critical',
              message: '发现 API Key',
              file: 'src/config.ts',
              line: 5,
              column: 1,
              category: 'security',
              suggestion: '使用环境变量',
            },
            {
              ruleId: 'secret.hardcoded-key',
              severity: 'high',
              message: '发现数据库密码',
              file: 'src/db.ts',
              line: 9,
            },
          ],
        },
      },
    ]);

    const findings = buildFindings(report);
    expect(findings).toHaveLength(2);
    expect(findings[0]).toMatchObject({
      ruleId: 'secret.hardcoded-key',
      file: 'src/config.ts',
      line: 5,
      column: 1,
      category: 'security',
      suggestion: '使用环境变量',
      source: 'guard',
    });
    // 未给出 column 时保持缺省（SARIF 层回退为 1）
    expect(findings[1].column).toBeUndefined();
    expect(findings[1].line).toBe(9);
  });

  it('violation 缺失 ruleId 时回落到所属检查的 checkId——ruleId 是 SARIF rules 表与 CI 路由的连接键，不能为空', () => {
    const report = makeGuardReport([
      {
        checkId: 'chk.fallback',
        status: 'failed',
        severity: 'error',
        message: '检查失败',
        details: {
          violations: [{ severity: 'error', message: '无规则号的违规', file: 'a.ts' }],
        },
      },
    ]);

    const findings = buildFindings(report);
    expect(findings).toHaveLength(1);
    expect(findings[0].ruleId).toBe('chk.fallback');
  });

  it('无 violations 明细的失败检查产出单条 finding，携带检查自身的 id/severity/message', () => {
    const report = makeGuardReport([
      { checkId: 'chk.lockfile', status: 'failed', severity: 'warning', message: '缺少 lockfile' },
    ]);

    const findings = buildFindings(report);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toEqual({
      ruleId: 'chk.lockfile',
      severity: 'warning',
      message: '缺少 lockfile',
      source: 'guard',
    });
  });

  it('无 violations 明细且 severity 越界（磁盘反序列化可能带入 critical/high）时必须归一为三档——透传会让 severityRank 为 undefined，CI 门禁对最高危问题静默放行', () => {
    const fallbackWith = (severity: string) =>
      makeGuardReport([{ checkId: 'chk.x', status: 'failed', severity, message: '检查失败' }]);

    expect(buildFindings(fallbackWith('critical'))[0].severity).toBe('error');
    expect(buildFindings(fallbackWith('high'))[0].severity).toBe('error');
    expect(buildFindings(fallbackWith('medium'))[0].severity).toBe('warning');
    // 未知严重级保守归为 warning：宁可多报也不静默丢 finding
    expect(buildFindings(fallbackWith('mystery'))[0].severity).toBe('warning');
  });

  it('引擎产出的 severity 别名归一为三档：critical/high→error，medium/warning→warning，low/info→info——归一是阈值比较的前提', () => {
    const violationWith = (severity: string) =>
      makeGuardReport([
        {
          checkId: 'chk.x',
          status: 'failed',
          severity: 'error',
          message: '检查失败',
          details: { violations: [{ ruleId: 'r', severity, message: 'm', file: 'a.ts' }] },
        },
      ]);

    expect(buildFindings(violationWith('critical'))[0].severity).toBe('error');
    expect(buildFindings(violationWith('high'))[0].severity).toBe('error');
    expect(buildFindings(violationWith('error'))[0].severity).toBe('error');
    expect(buildFindings(violationWith('medium'))[0].severity).toBe('warning');
    expect(buildFindings(violationWith('warning'))[0].severity).toBe('warning');
    expect(buildFindings(violationWith('low'))[0].severity).toBe('info');
    expect(buildFindings(violationWith('info'))[0].severity).toBe('info');
    // 未知严重级保守归为 warning：宁可多报 warning 也不静默丢 finding
    expect(buildFindings(violationWith('mystery'))[0].severity).toBe('warning');
  });
});
