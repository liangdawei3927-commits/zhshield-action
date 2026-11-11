import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { implementedCapabilities } from '@zh/shared';

/**
 * 合规基线从「项目体检」迁到「安全中心」后，接线必须锁死。
 *
 * 判据：合规视图是安全域结论的消费方，页面在安全中心；项目体检不再渲染它。
 * 这里直接断言源码接线——纯函数测试与注册表测试都覆盖不到「页面到底挂没挂」。
 */
describe('合规基线归安全中心', () => {
  const securityPage = readFileSync(resolve(__dirname, '../pages/SecurityPage.tsx'), 'utf-8');
  const reportParts = readFileSync(
    resolve(__dirname, '../pages/security-report-parts.tsx'),
    'utf-8',
  );
  const complianceHook = readFileSync(
    resolve(__dirname, '../compliance/use-compliance-report.ts'),
    'utf-8',
  );
  const inspectPage = readFileSync(resolve(__dirname, '../pages/InspectPage.tsx'), 'utf-8');

  it('安全中心是唯一的计算与渲染入口', () => {
    // 页面只经 hook 取数；求值与证据映射都收在 hook 内，页面不直接碰 baseline
    expect(securityPage).toContain('useComplianceReport(projectPath, detailReport)');
    expect(complianceHook).toContain('evaluateComplianceBaseline');
    expect(complianceHook).toContain('toSecurityEvidence(securityReport)');
    expect(reportParts).toContain('<ComplianceBaselineSection');
  });

  it('项目体检不再渲染合规基线，也不消费安全域证据', () => {
    expect(inspectPage).not.toContain('ComplianceBaselineSection');
    expect(inspectPage).not.toContain('evaluateComplianceBaseline');
  });

  it('能力注册表把合规基线记在安全域，项目体检不再宣称', () => {
    const securityIds = implementedCapabilities('security').map((cap) => cap.id);
    const inspectIds = implementedCapabilities('inspect').map((cap) => cap.id);
    expect(securityIds).toContain('security.compliance');
    expect(inspectIds).not.toContain('inspect.compliance');
  });
});
