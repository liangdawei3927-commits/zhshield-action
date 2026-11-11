import { describe, it, expect } from 'vitest';

import {
  COMPLIANCE_CONTROLS,
  COMPLIANCE_STANDARD,
  evaluateComplianceBaseline,
  type ComplianceEvidence,
} from '../compliance/baseline';

/**
 * 合规基线 v1（ASVS L1 子集）的验收用例。
 *
 * 锁定的不变量：
 *   1. 未覆盖条款永远是 uncovered，绝不会被算成 pass；
 *   2. 应有证据却没跑到（报告缺失 / 规则全跳过 / 漏洞库不可达）→ no-evidence，
 *      **不得**伪装成 pass（C4：未检测 ≠ 通过）；
 *   3. 证据齐全且有失败 → fail，并指出具体规则。
 */

const FULL_EVIDENCE_TIME = new Date().toISOString();

const cleanSecurity = {
  ledger: [
    { ruleId: 'security.scan.semgrep.sql-injection', status: 'passed' as const },
    { ruleId: 'security.scan.semgrep.command-injection', status: 'passed' as const },
    { ruleId: 'security.scan.semgrep.path-traversal', status: 'passed' as const },
    { ruleId: 'security.scan.semgrep.xss', status: 'passed' as const },
    { ruleId: 'security.scan.semgrep.csrf', status: 'passed' as const },
    { ruleId: 'security.scan.gitleaks.hardcoded-key', status: 'passed' as const },
    { ruleId: 'security.scan.external.helmet-check', status: 'passed' as const },
    { ruleId: 'security.scan.internal.tls-config', status: 'passed' as const },
  ],
  malwareTotal: 0,
  generatedAt: FULL_EVIDENCE_TIME,
};

const cleanDeps = {
  cve: { status: 'ok' as const, findings: 0 },
  lockfile: { status: 'clean' as const },
  typosquatFindings: 0,
  generatedAt: FULL_EVIDENCE_TIME,
};

const cleanEvidence: ComplianceEvidence = { security: cleanSecurity, deps: cleanDeps };

describe('合规基线 — 覆盖状态', () => {
  it('证据齐全且干净：9 条证据条款通过、5 条未覆盖，绝不出现“缺证据”', () => {
    const report = evaluateComplianceBaseline(cleanEvidence);
    expect(report.standard).toEqual(COMPLIANCE_STANDARD);
    expect(report.summary).toEqual({ pass: 9, fail: 0, noEvidence: 0, uncovered: 5, total: 14 });
    expect(report.controls).toHaveLength(COMPLIANCE_CONTROLS.length);
  });

  it('安全报告缺失 → 安全类条款一律 no-evidence（不得变通过）', () => {
    const report = evaluateComplianceBaseline({ security: null, deps: cleanDeps });
    const securityStates = report.controls
      .filter((control) =>
        [
          'SEC-INJECTION',
          'SEC-CSRF',
          'SEC-SECRETS',
          'SEC-MALWARE',
          'SEC-HEADERS-MIDDLEWARE',
          'CFG-TLS',
        ].includes(control.id),
      )
      .map((control) => control.state);
    expect(securityStates).toEqual([
      'no-evidence',
      'no-evidence',
      'no-evidence',
      'no-evidence',
      'no-evidence',
      'no-evidence',
    ]);
    expect(report.summary.noEvidence).toBe(6);
    expect(report.summary.pass).toBe(3); // 仅剩 3 条依赖条款有证据
  });

  it('注入类规则失败 → fail，并指出具体规则 id', () => {
    const report = evaluateComplianceBaseline({
      security: {
        ...cleanSecurity,
        ledger: cleanSecurity.ledger.map((entry) =>
          entry.ruleId === 'security.scan.semgrep.sql-injection'
            ? { ...entry, status: 'failed' as const }
            : entry,
        ),
      },
      deps: cleanDeps,
    });
    const injection = report.controls.find((control) => control.id === 'SEC-INJECTION');
    expect(injection?.state).toBe('fail');
    expect(injection?.detail).toContain('security.scan.semgrep.sql-injection');
    expect(report.summary.fail).toBe(1);
  });

  it('TLS 配置规则失败 → CFG-TLS 判 fail，并回显证据时间', () => {
    const report = evaluateComplianceBaseline({
      security: {
        ...cleanSecurity,
        ledger: cleanSecurity.ledger.map((entry) =>
          entry.ruleId === 'security.scan.internal.tls-config'
            ? { ...entry, status: 'failed' as const }
            : entry,
        ),
      },
      deps: cleanDeps,
    });
    const tls = report.controls.find((control) => control.id === 'CFG-TLS');
    expect(tls?.state).toBe('fail');
    expect(tls?.detail).toContain('security.scan.internal.tls-config');
    expect(tls?.detail).toContain('证据');
  });

  it('老报告没有 TLS 规则记录 → CFG-TLS 是 no-evidence（不得当成通过）', () => {
    const report = evaluateComplianceBaseline({
      security: {
        ...cleanSecurity,
        ledger: cleanSecurity.ledger.filter(
          (entry) => entry.ruleId !== 'security.scan.internal.tls-config',
        ),
      },
      deps: cleanDeps,
    });
    const tls = report.controls.find((control) => control.id === 'CFG-TLS');
    expect(tls?.state).toBe('no-evidence');
    expect(tls?.detail).toContain('未检测 ≠ 通过');
  });

  it('对应规则全部被跳过（归属让位/缺工具）→ no-evidence', () => {
    const report = evaluateComplianceBaseline({
      security: {
        ...cleanSecurity,
        ledger: [
          { ruleId: 'security.scan.semgrep.sql-injection', status: 'skipped' },
          { ruleId: 'security.scan.semgrep.command-injection', status: 'skipped' },
        ],
      },
      deps: cleanDeps,
    });
    const injection = report.controls.find((control) => control.id === 'SEC-INJECTION');
    expect(injection?.state).toBe('no-evidence');
    expect(injection?.detail).toContain('跳过');
  });

  it('CVE 漏洞库不可达 → no-evidence（≠ 0 漏洞）；锁文件不一致 → fail', () => {
    const report = evaluateComplianceBaseline({
      security: cleanSecurity,
      deps: {
        cve: { status: 'unavailable', findings: 0 },
        lockfile: { status: 'modified' },
        typosquatFindings: 1,
      },
    });
    expect(report.controls.find((control) => control.id === 'DEP-CVE')?.state).toBe('no-evidence');
    expect(report.controls.find((control) => control.id === 'DEP-LOCKFILE')?.state).toBe('fail');
    expect(report.controls.find((control) => control.id === 'DEP-TYPOSQUAT')?.state).toBe('fail');
  });

  it('证据超过 24h → 打「未重新检测」标（判定结果不变）', () => {
    const now = Date.parse('2026-11-12T00:00:00.000Z');
    const report = evaluateComplianceBaseline(
      {
        security: { ...cleanSecurity, generatedAt: '2026-11-10T00:00:00.000Z' },
        deps: { ...cleanDeps, generatedAt: '2026-11-11T23:00:00.000Z' },
      },
      now,
    );
    const injection = report.controls.find((control) => control.id === 'SEC-INJECTION');
    const cve = report.controls.find((control) => control.id === 'DEP-CVE');
    // 判定不变：过期不改变 pass/fail，只让「多久没验」看得见
    expect(injection?.state).toBe('pass');
    expect(injection?.detail).toContain('未重新检测');
    expect(cve?.detail).toContain('证据');
    expect(cve?.detail).not.toContain('未重新检测');
  });

  it('未覆盖条款永远是 uncovered，且不参与“通过”计数', () => {
    const report = evaluateComplianceBaseline({ security: null, deps: null });
    const uncovered = report.controls.filter((control) => control.state === 'uncovered');
    expect(uncovered.map((control) => control.id)).toEqual([
      'CFG-HEADERS',
      'AUTH-SESSION',
      'LOG-AUDIT',
      'KEY-ROTATION',
      'SUPPLY-SIGNATURE',
    ]);
    expect(report.summary.pass).toBe(0);
    expect(report.summary.noEvidence).toBe(9);
  });
});
