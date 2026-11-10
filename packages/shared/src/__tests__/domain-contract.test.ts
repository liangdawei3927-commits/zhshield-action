import { describe, it, expect } from 'vitest';
import {
  DOMAIN_IDS,
  createDomainReport,
  toFileUri,
  toRelativePath,
  resolveOwnerId,
  validateOwnershipRegistry,
  validateCapabilityRegistry,
  TOOL_CAPABILITIES,
  SCAN_DOMAIN_BUDGETS,
} from '../index';

describe('路径归一化（修 P1：file:// URI 双拼）', () => {
  it('Given 相对路径，When 生成跳转 URI，Then 只拼一次 projectRoot', () => {
    expect(toFileUri('/tmp/demo', 'src/a.ts')).toBe('file:///tmp/demo/src/a.ts');
  });

  it('Given issue.file 已是绝对路径，When 生成 URI，Then 不含重复的 projectRoot（回归）', () => {
    const uri = toFileUri('/tmp/demo', '/tmp/demo/src/a.ts');
    expect(uri).toBe('file:///tmp/demo/src/a.ts');
    // 旧实现 `file://${join(root, file)}` 会产出 /tmp/demo/tmp/demo/...
    expect(uri.match(/\/tmp\/demo/g)).toHaveLength(1);
  });

  it('Given 绝对路径，When 归一化为相对路径，Then 相对 projectRoot（落盘形态）', () => {
    expect(toRelativePath('/tmp/demo', '/tmp/demo/src/a.ts')).toBe('src/a.ts');
    expect(toRelativePath('/tmp/demo', 'src/a.ts')).toBe('src/a.ts');
  });

  it('Given 含空格与中文的路径，When 生成 URI，Then 百分号编码正确', () => {
    expect(toFileUri('/tmp/demo', 'src/中文 目录/a.ts')).toBe(
      'file:///tmp/demo/src/%E4%B8%AD%E6%96%87%20%E7%9B%AE%E5%BD%95/a.ts',
    );
  });
});

describe('C1 单源归属（规范 §四 O1–O10）', () => {
  it('Given 十域常量，When 校验归属注册表，Then 0 冲突（A1）', () => {
    expect(validateOwnershipRegistry()).toEqual([]);
    expect(DOMAIN_IDS).toHaveLength(11);
  });

  it.each([
    ['inspect.scan.official.duplication', 'refactor', 'O1 重复代码唯一归重构'],
    ['guard.scan.official.sensitive-info', 'security', 'O3 密钥/敏感信息唯一归安全'],
    ['inspect.scan.official.semgrep', 'security', 'O9 代码漏洞唯一归安全'],
    ['inspect.scan.official.dependency-audit', 'deps', 'O10 依赖审计唯一归依赖管家'],
    ['inspect.scan.external.dependency-audit', 'deps', 'O10 依赖审计唯一归依赖管家（external 变体）'],
    ['deps.scan.official.unused-dependency', 'garbage', 'O7 未使用依赖唯一归垃圾清理'],
    ['performance.scan.official.nested-loop', 'performance', 'O4 运行时反模式归性能域'],
    ['performance.runtime.nested-loop', 'performance', 'O4 运行时反模式归性能域'],
    ['performance.runtime.sync-io', 'performance', 'O4 运行时反模式归性能域'],
    ['inspect.scan.official.complexity', 'inspect', 'O4 圈复杂度归体检'],
  ])('Given %s，When 解析 owner，Then 裁定为 %s（%s）', (ruleId, expected) => {
    expect(resolveOwnerId(ruleId)).toBe(expected);
  });

  it('Given 注册表外的 ruleId，When 解析 owner，Then 返回 null（Router 会上报为 unrouted）', () => {
    expect(resolveOwnerId('unknown.family.thing')).toBeNull();
  });
});

describe('C4 / §6 统一信封口径', () => {
  const base = {
    domain: 'inspect' as const,
    projectPath: '/tmp/demo',
    generatedAt: '2026-10-31T00:00:00.000Z',
    issues: [],
  };

  it('Given 0 项检查且有 skipped，When 构造报告，Then status=unavailable 且分数为 null（不填 100）', () => {
    const report = createDomainReport({
      ...base,
      coverage: { scannedFiles: 0, totalFiles: 10, evaluatedChecks: 0, plannedChecks: 5 },
      skipped: [{ tool: 'eslint', reason: 'no-rules' }],
      scoreValue: 100,
      basis: 'issues',
    });

    expect(report.status).toBe('unavailable');
    expect(report.score.value).toBeNull();
    expect(report.score.basis).toBe('none');
    expect(report.score.issuesCount).toBe(0);
  });

  it('Given 0 项检查且无 skipped，When 构造报告，Then status=not-run 且分数为 null', () => {
    const report = createDomainReport({
      ...base,
      coverage: { scannedFiles: 0, totalFiles: 0, evaluatedChecks: 0, plannedChecks: 0 },
      skipped: [],
      scoreValue: 0,
      basis: 'issues',
    });

    expect(report.status).toBe('not-run');
    expect(report.score.value).toBeNull();
  });

  it('Given 覆盖率不足阈值，When 构造报告，Then uncovered=true 且 status=partial', () => {
    const report = createDomainReport({
      ...base,
      coverage: { scannedFiles: 2, totalFiles: 10, evaluatedChecks: 5, plannedChecks: 5 },
      skipped: [],
      scoreValue: 88,
      basis: 'issues',
    });

    expect(report.status).toBe('partial');
    expect(report.score.uncovered).toBe(true);
    expect(report.score.value).toBe(88);
  });

  it('Given 工具错误，When 构造报告，Then 只进 skipped、不进 issuesCount（C4）', () => {
    const report = createDomainReport({
      ...base,
      coverage: { scannedFiles: 10, totalFiles: 10, evaluatedChecks: 5, plannedChecks: 5 },
      skipped: [
        { tool: 'trivy', reason: 'tool-timeout', detail: '60s' },
        { tool: 'osv', reason: 'network-unreachable' },
      ],
      scoreValue: 92,
      basis: 'issues',
    });

    expect(report.status).toBe('ok');
    expect(report.score.issuesCount).toBe(0);
    expect(report.skipped).toHaveLength(2);
  });
});

describe('A11 能力注册表校验', () => {
  it('Given 工具能力表，When 校验，Then 0 违约（ruleId 唯一、owner 一致、hardTimeout < budget）', () => {
    expect(validateCapabilityRegistry()).toEqual([]);
  });

  it('Given 每条能力声明，When 检查硬超时，Then 均小于域预算（§7.5）', () => {
    for (const cap of TOOL_CAPABILITIES) {
      expect(cap.hardTimeoutMs).toBeLessThan(cap.budgetMs);
    }
  });

  it('Given 规范 §7.5 预算表，When 读取，Then 体检/安全/依赖预算有值且为整数秒级', () => {
    // inspect 150s：85 条规则实测 92.89s，旧 90s 预算让它每次精确熔断（见预算表注释）
    expect(SCAN_DOMAIN_BUDGETS.inspect).toBe(150_000);
    // security 300s：云端规则集下实测 173s / 192s，旧 120s 让它每次精确熔断
    expect(SCAN_DOMAIN_BUDGETS.security).toBe(300_000);
    expect(SCAN_DOMAIN_BUDGETS.deps).toBe(90_000);
    expect(SCAN_DOMAIN_BUDGETS.guard).toBe(10_000);
  });
});
