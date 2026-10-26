/**
 * P1-6 分数口径统一回归测试（实测报告 2026-10-27）。
 *
 * 三条不变量：
 * 1. 计数与扣分分离：secrets.activeCount / deps.upgradable 只参与扣分，
 *    不再加进维度 issues；维度 issues 数 = 域快照里真实存在的条目数。
 * 2. 安全域双路合并：漏洞（vuln）与密钥（secret）谁后写都不抹掉对方的发现，
 *    secret:* 前缀是两类的分界。
 * 3. 来源标注：dimensionSources 是评分维 → 诊断数据源的静态映射。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildHealthDimensions } from '@zh/scoring';
import {
  persistSecurityDomainEntries,
  readDomainSnapshot,
  normalizeDepsSource,
  type DiagnosticEntry,
} from '../../electron/zh-diagnostics';
import { dimensionSources } from '../pages/domain-score-logic';
import type { DependencyReportData } from '../types/electron';

const vulnEntry = (id: string): DiagnosticEntry => ({
  ruleId: id,
  severity: 'error',
  category: 'security',
  message: 'vuln',
  file: 'a.ts',
  autoFixable: false,
  source: 'security',
  fingerprint: `${id}:0`,
});

const secretEntry = (id: string): DiagnosticEntry => ({
  ruleId: `secret:${id}`,
  severity: 'error',
  category: 'security',
  message: 'secret',
  file: 'b.ts',
  autoFixable: false,
  source: 'security',
  fingerprint: `secret:${id}:0`,
});

describe('P1-6 安全域双路合并（persistSecurityDomainEntries）', () => {
  it('先密钥后漏洞：漏洞覆盖自己那类、保留密钥条目', async () => {
    const project = mkdtempSync(join(tmpdir(), 'zh-p1-6-sec-'));
    try {
      await persistSecurityDomainEntries(project, [secretEntry('k1'), secretEntry('k2')], 'secret');
      await persistSecurityDomainEntries(project, [vulnEntry('vuln/CVE-1')], 'vuln');
      const snap = await readDomainSnapshot(project, 'security');
      expect(snap!.issues.map((i) => i.ruleId).sort()).toEqual(['secret:k1', 'secret:k2', 'vuln/CVE-1']);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('先漏洞后密钥清零：密钥全量覆盖（含 0 条 = 全部已处理）、保留漏洞条目', async () => {
    const project = mkdtempSync(join(tmpdir(), 'zh-p1-6-sec2-'));
    try {
      await persistSecurityDomainEntries(project, [vulnEntry('vuln/CVE-1')], 'vuln');
      await persistSecurityDomainEntries(project, [secretEntry('k1')], 'secret');
      // 密钥复核后全部消除：写 0 条 secret，旧密钥条目必须被清掉而非残留
      await persistSecurityDomainEntries(project, [], 'secret');
      const snap = await readDomainSnapshot(project, 'security');
      expect(snap!.issues.map((i) => i.ruleId)).toEqual(['vuln/CVE-1']);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('重复写同一类：同类旧条目被覆盖，不出现双份', async () => {
    const project = mkdtempSync(join(tmpdir(), 'zh-p1-6-sec3-'));
    try {
      await persistSecurityDomainEntries(project, [vulnEntry('vuln/A'), vulnEntry('vuln/B')], 'vuln');
      await persistSecurityDomainEntries(project, [vulnEntry('vuln/A')], 'vuln');
      const snap = await readDomainSnapshot(project, 'security');
      expect(snap!.issues.filter((i) => i.ruleId === 'vuln/A')).toHaveLength(1);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});

describe('P1-6 计数与扣分分离（deps upgrade 条目 ↔ 维度 issues 可验算）', () => {
  const depsData = {
    typosquatFindings: [],
    lockfileVerification: { status: 'clean', diffs: [], integrityFailures: [] },
    licenseMatrix: { total: 0, byCategory: {}, entries: [] },
    upgradeAssessments: [
      { nodeId: 'pkg-a', candidates: [{ targetVersion: '2.0.0', risk: 'low', breakingChanges: [] }] },
      { nodeId: 'pkg-b', candidates: [{ targetVersion: '3.1.0', risk: 'medium', breakingChanges: [] }] },
      { nodeId: 'pkg-c', candidates: [] },
    ],
    envEntries: [],
    generatedAt: 'T',
  } as unknown as DependencyReportData;

  it('normalizeDepsSource：candidates>0 的评估逐条落 dependency 条目，candidates=0 不落', () => {
    const entries = normalizeDepsSource(depsData).filter((e) => e.category === 'dependency');
    expect(entries.map((e) => e.ruleId)).toEqual(['upgrade:pkg-a', 'upgrade:pkg-b']);
  });

  it('Σ域条数 == 维度 issues：快照条目喂给评分后 deps.issues 与条数一致（不再双计/漏计）', () => {
    const entries = normalizeDepsSource(depsData).filter((e) => e.category === 'dependency');
    const upgradable = depsData.upgradeAssessments.filter((a) => a.candidates.length > 0).length;
    const dims = buildHealthDimensions({
      guard: null,
      inspect: {
        issues: entries.map((e) => ({ severity: e.severity, category: e.category, ruleId: e.ruleId })),
      },
      extras: {
        deps: { vulnerabilities: { critical: 0, high: 0, medium: 0 }, upgradable },
      },
    });
    const deps = dims.find((d) => d.name === 'dependencies')!;
    expect(deps.status).toBe('scored');
    expect(deps.issues).toBe(entries.length); // 2 条 upgrade 条目 = 2 issues
  });

  it('extras 直喂（旧汇总路径）：upgradable 只扣分不计入 issues', () => {
    const dims = buildHealthDimensions({
      guard: null,
      inspect: { issues: [] },
      extras: {
        deps: { vulnerabilities: { critical: 1, high: 0, medium: 0 }, upgradable: 5 },
      },
    });
    const deps = dims.find((d) => d.name === 'dependencies')!;
    expect(deps.score).toBe(88); // 100 − 12（critical），upgradable 不扣 issue 数
    expect(deps.issues).toBe(0);
  });
});

describe('P1-6 来源标注（dimensionSources）', () => {
  it('quality/security/dependencies/gate 的来源映射与评分输入组装一致', () => {
    expect(dimensionSources('quality')).toEqual(['inspect', 'performance']);
    expect(dimensionSources('security')).toEqual(['security', 'secrets']);
    expect(dimensionSources('dependencies')).toEqual(['deps']);
    expect(dimensionSources('gate')).toEqual(['guard']);
  });

  it('其余维度回退到自身单源', () => {
    expect(dimensionSources('refactor')).toEqual(['refactor']);
    expect(dimensionSources('sentinel')).toEqual(['sentinel']);
    expect(dimensionSources('backup')).toEqual(['backup']);
  });
});

describe('P1-6 结构守卫（落盘调用点不被回退）', () => {
  const read = (p: string) => readFileSync(join(__dirname, p), 'utf-8');

  it('runSecurityHandler 用双路合并写 vuln 类，不再整段覆盖 security 域', () => {
    const src = read('../../electron/ipc/engines-scanners.ts');
    expect(src).toContain("persistSecurityDomainEntries(projectPath, normalizeSecuritySource(data), 'vuln')");
    expect(src).not.toContain('persistDiagnosticsFromEntries(projectPath, normalizeSecuritySource');
  });

  it('runSecretsHandler 落 active 密钥条目为 secret 类', () => {
    const src = read('../../electron/ipc/engines-secrets.ts');
    expect(src).toContain("persistSecurityDomainEntries(projectPath, activeSecretEntries(report), 'secret')");
    expect(src).toContain("finding.status === 'active'");
  });

  it('桶文件导出 persistSecurityDomainEntries', () => {
    const src = read('../../electron/zh-diagnostics.ts');
    expect(src).toContain('persistSecurityDomainEntries');
  });
});
