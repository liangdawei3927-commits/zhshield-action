import { describe, it, expect } from 'vitest';
import { RuleConflictResolver } from '../rule-conflict-resolver';
import type { Issue } from '@zh/shared';
import type { RuleFinding } from '../rule-conflict-resolver';

// ─── fixtures（对齐仓库真实扫描结果形态，参考 cross-validator.test.ts）───

function makeIssue(overrides: Partial<Issue> & { ruleId: string; fingerprint: string }): Issue {
  return {
    id: overrides.ruleId,
    category: 'security',
    severity: 'error',
    message: overrides.message || `policy violation: ${overrides.ruleId}`,
    file: overrides.file || overrides.fingerprint.split(':').at(-1) || '',
    line: 17,
    source: 'security',
    autoFixable: false,
    ...overrides,
  };
}

/** 测试专用破坏器：给合法 finding 打上缺字段/坏字段的补丁（无类型断言） */
function corrupt(finding: RuleFinding, patch: Record<string, unknown>): RuleFinding {
  return { ...finding , ...patch};
}

const SEMGREP_BACKDOOR = makeIssue({
  ruleId: 'semgrep:backdoor.eval',
  message: 'Detected dynamic code execution via eval() with remote payload',
  fingerprint: 'semgrep:backdoor.eval:src/utils/exec.ts',
  severity: 'error',
});

const GITLEAKS_AWS_TOKEN = makeIssue({
  ruleId: 'gitleaks:aws-access-token',
  message: 'AWS access key committed in source',
  fingerprint: 'gitleaks:aws-access-token:src/config/aws.ts',
  severity: 'error',
});

const TRIVY_CVE = makeIssue({
  ruleId: 'CVE-2024-1234',
  message: 'lodash@4.17.20: ReDoS',
  fingerprint: 'trivy:CVE-2024-1234:lodash',
  severity: 'warning',
});

describe('RuleConflictResolver', () => {
  const resolver = new RuleConflictResolver();

  // ── 语义 1：多来源同指纹同判定 → confirmed ─────────────────

  it('keeps agreeing findings from two sources in confirmed as corroborated', () => {
    const findings = [
      RuleConflictResolver.finding('semgrep', 'secret', GITLEAKS_AWS_TOKEN),
      RuleConflictResolver.finding('gitleaks', 'secret', {
        ...GITLEAKS_AWS_TOKEN,
        ruleId: 'semgrep:generic-api-key',
      }),
    ];

    const report = resolver.resolve(findings);

    expect(report.confirmed).toHaveLength(1);
    expect(report.confirmed[0].confidence).toBe('corroborated');
    expect(report.confirmed[0].sources).toEqual(['gitleaks', 'semgrep']);
    expect(report.confirmed[0].verdict).toBe('secret');
    expect(report.confirmed[0].suggestedSeverity).toBe('error');
    expect(report.summary.confirmed).toBe(1);
    expect(report.summary.total).toBe(1);
  });

  it('keeps a single-source unopposed finding in confirmed', () => {
    const report = resolver.resolve([
      RuleConflictResolver.finding('semgrep', 'injection', SEMGREP_BACKDOOR),
    ]);

    expect(report.confirmed).toHaveLength(1);
    expect(report.confirmed[0].confidence).toBe('unopposed');
    expect(report.confirmed[0].sources).toEqual(['semgrep']);
    expect(report.summary.total).toBe(1);
  });

  // ── 语义 2：显式豁免 → falsePositives（移出决策集）──────────

  it('moves dismissed findings out of the decision set into falsePositives with reason', () => {
    const findings = [RuleConflictResolver.finding('semgrep', 'injection', SEMGREP_BACKDOOR)];
    const dismissals = [
      RuleConflictResolver.dismissal(
        SEMGREP_BACKDOOR.fingerprint,
        'allowlist/security-ignore.yml',
        'test-only eval in sandboxed fixture',
      ),
    ];

    const report = resolver.resolve(findings, dismissals);

    expect(report.confirmed).toHaveLength(0);
    expect(report.falsePositives).toHaveLength(1);
    expect(report.falsePositives[0].fingerprint).toBe(SEMGREP_BACKDOOR.fingerprint);
    expect(report.falsePositives[0].dismissedBy).toBe('allowlist/security-ignore.yml');
    expect(report.falsePositives[0].reason).toBe('test-only eval in sandboxed fixture');
    expect(report.falsePositives[0].verdicts).toEqual(['injection']);
    // 不进 Guard 决策集：summary.confirmed 为 0
    expect(report.summary.confirmed).toBe(0);
    expect(report.summary.falsePositives).toBe(1);
  });

  it('lets dismissal win even when two sources corroborate the location', () => {
    const findings = [
      RuleConflictResolver.finding('trivy', 'vulnerability', TRIVY_CVE),
      RuleConflictResolver.finding('grype', 'vulnerability', {
        ...TRIVY_CVE,
        ruleId: 'grype:CVE-2024-1234',
      }),
    ];
    const dismissals = [
      RuleConflictResolver.dismissal(TRIVY_CVE.fingerprint, 'trivy/policy/ignore.yml', 'superseded by patched lodash@4.17.21 pin'),
    ];

    const report = resolver.resolve(findings, dismissals);

    expect(report.confirmed).toHaveLength(0);
    expect(report.falsePositives).toHaveLength(1);
    expect(report.falsePositives[0].dismissedBy).toBe('trivy/policy/ignore.yml');
    expect(report.summary.confirmed).toBe(0);
  });

  // ── 语义 3：同指纹矛盾分类 → conflicts（双方保留）───────────

  it('surfaces conflicting classifications with both sides attached and no double count', () => {
    const findings = [
      RuleConflictResolver.finding('trivy', 'vulnerability', TRIVY_CVE),
      RuleConflictResolver.finding('gitleaks', 'secret', {
        ...TRIVY_CVE,
        ruleId: 'gitleaks:generic',
        fingerprint: TRIVY_CVE.fingerprint,
      }),
    ];

    const report = resolver.resolve(findings);

    expect(report.confirmed).toHaveLength(0);
    expect(report.conflicts).toHaveLength(1);
    const conflict = report.conflicts[0];
    expect(conflict.fingerprint).toBe(TRIVY_CVE.fingerprint);
    expect(conflict.sides).toHaveLength(2);
    expect(conflict.sides.map((s) => s.verdict)).toEqual(['secret', 'vulnerability']);
    expect(conflict.sides.map((s) => s.sources)).toEqual([['gitleaks'], ['trivy']]);
    // 不被静默丢弃：双方 issue 都在
    expect(conflict.sides.flatMap((s) => s.issues)).toHaveLength(2);
    // 只计一次，不进 confirmed
    expect(report.summary.total).toBe(1);
    expect(report.summary.conflicts).toBe(1);
    expect(report.summary.confirmed).toBe(0);
  });

  // ── 语义 4：跨工具重复（同指纹同判定）→ 去重为一条 ──────────

  it('dedupes identical cross-tool duplicates into one confirmed entry listing all reporters', () => {
    const findings = [
      RuleConflictResolver.finding('semgrep', 'secret', GITLEAKS_AWS_TOKEN),
      RuleConflictResolver.finding('gitleaks', 'secret', GITLEAKS_AWS_TOKEN),
      RuleConflictResolver.finding('inspect', 'secret', GITLEAKS_AWS_TOKEN),
    ];

    const report = resolver.resolve(findings);

    expect(report.confirmed).toHaveLength(1);
    expect(report.confirmed[0].sources).toEqual(['gitleaks', 'inspect', 'semgrep']);
    expect(report.confirmed[0].confidence).toBe('corroborated');
    expect(report.summary.total).toBe(1);
    expect(report.summary.confirmed).toBe(1);
  });

  // ── 语义 5：空输入 / 畸形条目 ───────────────────────────────

  it('returns an empty ok-shaped report for empty input without throwing', () => {
    const report = resolver.resolve([], []);

    expect(report).toEqual({
      confirmed: [],
      falsePositives: [],
      conflicts: [],
      invalid: [],
      summary: { total: 0, confirmed: 0, falsePositives: 0, conflicts: 0, invalid: 0 },
    });
  });

  it('isolates malformed findings into the invalid lane instead of crashing', () => {
    const valid = RuleConflictResolver.finding('semgrep', 'injection', SEMGREP_BACKDOOR);
    const findings: RuleFinding[] = [
      corrupt(valid, { source: '' }),
      corrupt(valid, { verdict: undefined }),
      corrupt(valid, { issue: null }),
      corrupt(valid, { issue: { ...SEMGREP_BACKDOOR, fingerprint: '' } }),
      valid,
    ];

    const report = resolver.resolve(findings);

    expect(report.invalid).toHaveLength(4);
    expect(report.invalid.map((e) => e.kind)).toEqual(['finding', 'finding', 'finding', 'finding']);
    expect(report.invalid.map((e) => e.index)).toEqual([0, 1, 2, 3]);
    expect(report.invalid[0].reason).toBe('finding source missing or empty');
    expect(report.invalid[1].reason).toBe('finding verdict missing or empty');
    expect(report.invalid[2].reason).toBe('finding issue missing or not an object');
    expect(report.invalid[3].reason).toBe('finding issue.fingerprint missing or empty');
    expect(report.confirmed).toHaveLength(1);
    expect(report.summary.invalid).toBe(4);
  });

  it('isolates malformed dismissals into the invalid lane instead of crashing', () => {
    const report = resolver.resolve(
      [RuleConflictResolver.finding('gitleaks', 'secret', GITLEAKS_AWS_TOKEN)],
      [
        RuleConflictResolver.dismissal(GITLEAKS_AWS_TOKEN.fingerprint, 'allowlist/x.yml', ''),
        RuleConflictResolver.dismissal('', 'allowlist/x.yml', 'no fingerprint'),
        RuleConflictResolver.dismissal(GITLEAKS_AWS_TOKEN.fingerprint, 'allowlist/ok.yml', 'rotated key'),
      ],
    );

    expect(report.invalid).toHaveLength(2);
    expect(report.invalid.every((e) => e.kind === 'dismissal')).toBe(true);
    expect(report.invalid[0].reason).toBe('dismissal reason missing or empty');
    expect(report.invalid[1].reason).toBe('dismissal fingerprint missing or empty');
    expect(report.falsePositives).toHaveLength(1);
    expect(report.falsePositives[0].dismissedBy).toBe('allowlist/ok.yml');
  });

  // ── 确定性与幂等性 ─────────────────────────────────────────

  it('is deterministic: same input twice produces deep-equal reports', () => {
    const findings = [
      RuleConflictResolver.finding('semgrep', 'secret', GITLEAKS_AWS_TOKEN),
      RuleConflictResolver.finding('gitleaks', 'secret', GITLEAKS_AWS_TOKEN),
      RuleConflictResolver.finding('trivy', 'vulnerability', TRIVY_CVE),
      RuleConflictResolver.finding('gitleaks', 'secret', { ...TRIVY_CVE, fingerprint: TRIVY_CVE.fingerprint }),
    ];
    const dismissals = [
      RuleConflictResolver.dismissal(GITLEAKS_AWS_TOKEN.fingerprint, 'allowlist/a.yml', 'rotated key'),
    ];

    const first = resolver.resolve(findings, dismissals);
    const second = resolver.resolve(findings, dismissals);

    expect(first).toEqual(second);
  });

  it('does not double-count when resolving an already-resolved report', () => {
    const findings = [
      RuleConflictResolver.finding('semgrep', 'secret', GITLEAKS_AWS_TOKEN),
      RuleConflictResolver.finding('gitleaks', 'secret', GITLEAKS_AWS_TOKEN),
      RuleConflictResolver.finding('trivy', 'vulnerability', TRIVY_CVE),
    ];

    const first = resolver.resolve(findings);
    // 把 resolved 结果还原回输入再跑一遍（模拟重复接线）
    const rehydrated = first.confirmed.flatMap((entry) =>
      entry.sources.map((source) =>
        RuleConflictResolver.finding(source, entry.verdict, entry.issues[0]),
      ),
    );
    const second = resolver.resolve(rehydrated);

    expect(second.summary.confirmed).toBe(first.summary.confirmed);
    expect(second.confirmed.map((c) => c.fingerprint)).toEqual(first.confirmed.map((c) => c.fingerprint));
    expect(second.confirmed[0].sources).toEqual(first.confirmed[0].sources);
    expect(second.summary.total).toBe(first.summary.total);
  });

  // ── 综合场景（计划验收：自相矛盾规则结果不污染 Guard 决策）────

  it('separates a self-contradictory rule batch into the right lanes end-to-end', () => {
    const findings = [
      // 被豁免的误报
      RuleConflictResolver.finding('semgrep', 'injection', SEMGREP_BACKDOOR),
      // 双工具印证的真实问题
      RuleConflictResolver.finding('gitleaks', 'secret', GITLEAKS_AWS_TOKEN),
      RuleConflictResolver.finding('semgrep', 'secret', {
        ...GITLEAKS_AWS_TOKEN,
        ruleId: 'semgrep:generic-api-key',
      }),
      // 分类矛盾
      RuleConflictResolver.finding('trivy', 'vulnerability', TRIVY_CVE),
      RuleConflictResolver.finding('gitleaks', 'secret', { ...TRIVY_CVE, fingerprint: TRIVY_CVE.fingerprint }),
    ];
    const dismissals = [
      RuleConflictResolver.dismissal(
        SEMGREP_BACKDOOR.fingerprint,
        'allowlist/security-ignore.yml',
        'sandboxed fixture',
      ),
    ];

    const report = resolver.resolve(findings, dismissals);

    // 决策集只含 confirmed 的真实问题
    expect(report.summary).toEqual({
      total: 3,
      confirmed: 1,
      falsePositives: 1,
      conflicts: 1,
      invalid: 0,
    });
    expect(report.confirmed[0].fingerprint).toBe(GITLEAKS_AWS_TOKEN.fingerprint);
    expect(report.falsePositives[0].fingerprint).toBe(SEMGREP_BACKDOOR.fingerprint);
    expect(report.conflicts[0].fingerprint).toBe(TRIVY_CVE.fingerprint);
  });
});
