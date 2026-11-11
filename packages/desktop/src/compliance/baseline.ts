/**
 * 合规基线 v1（ASVS L1 子集）— 只读映射，不新增扫描。
 *
 * 背景：安全页的「安全编码规范与合规基线校验」长期 planned（全仓无实现）。
 * 按项目纪律（C1 单源归属、C4 未检测 ≠ 通过），合规不应再写一套扫描器，
 * 而应把各域既有结论按标准条款汇总成「通过 / 失败 / 缺证据 / 未覆盖」。
 *
 * 本模块是纯函数：输入各域已落盘报告的摘要，输出条款清单与状态；
 * 不做 I/O、不启动工具进程、不改任何评分。
 *
 * 为什么放桌面端而不是 shared：阶段一只做体检页只读视图；等 CLI 也要
 * `zhshield compliance` 时再上移（避免新增文件在注入副本里不同步的坑）。
 *
 * 覆盖语义（与评分口径解耦）：
 *   · pass        —— 有证据且无问题
 *   · fail        —— 有证据且存在问题
 *   · no-evidence —— 应有证据但本次没跑到/没落盘（**不得**当成通过）
 *   · uncovered   —— 本产品尚未实现该项检查（只在能力边界里告知）
 */
import type { DependencyReportData, SecurityScanReportData } from '../types/electron';

/** 基线标识（能力注册表 implementedBy 的证据串，勿改） */
export const COMPLIANCE_BASELINE_ID = 'compliance-baseline';

export type ComplianceState = 'pass' | 'fail' | 'no-evidence' | 'uncovered';

/** 条款的证据形态：决定从哪份报告取结论 */
type ControlRule =
  | { kind: 'security-rules'; ruleTokens: readonly string[] }
  | { kind: 'security-malware' }
  | { kind: 'deps-cve' }
  | { kind: 'deps-lockfile' }
  | { kind: 'deps-typosquat' }
  | { kind: 'uncovered' };

export interface ComplianceControl {
  id: string;
  /** 标准条款编号（ASVS L1 子集） */
  clause: string;
  title: string;
  /** 证据来源（给用户看，不用维护者术语） */
  source: string;
  rule: ControlRule;
}

export const COMPLIANCE_STANDARD = {
  id: 'asvs-l1-subset',
  name: 'ASVS L1（子集）',
  version: 'v1',
} as const;

/**
 * 条款表 v1：只放**已有证据源**或**明确未实现**的条款，不做“先占位再补实现”。
 * 新增条款必须同时给出证据形态，否则只能登记为 uncovered。
 */
export const COMPLIANCE_CONTROLS: readonly ComplianceControl[] = [
  {
    id: 'SEC-INJECTION',
    clause: 'ASVS 5.3.3',
    title: '注入类漏洞（SQL / 命令 / 路径穿越 / XSS）',
    source: '安全中心 · semgrep 规则',
    rule: { kind: 'security-rules', ruleTokens: ['sql-injection', 'command-injection', 'path-traversal', 'xss'] },
  },
  {
    id: 'SEC-CSRF',
    clause: 'ASVS 5.1.6',
    title: 'CSRF 防护',
    source: '安全中心 · semgrep 规则',
    rule: { kind: 'security-rules', ruleTokens: ['csrf'] },
  },
  {
    id: 'SEC-SECRETS',
    clause: 'ASVS 2.10.3',
    title: '硬编码密钥 / 凭证',
    source: '安全中心 · gitleaks',
    rule: { kind: 'security-rules', ruleTokens: ['hardcoded-key', 'gitleaks', 'secrets'] },
  },
  {
    id: 'SEC-MALWARE',
    clause: 'ASVS 5.5',
    title: '恶意代码特征（反弹 Shell / 后门 / 供应链投毒）',
    source: '安全中心 · 病毒查杀',
    rule: { kind: 'security-malware' },
  },
  {
    id: 'SEC-HEADERS-MIDDLEWARE',
    clause: 'ASVS 14.4（代理证据）',
    title: '安全响应头中间件（Helmet）已配置',
    source: '安全中心 · helmet-check（依赖检测）',
    // 证据只到「helmet 在依赖里被配置」，不到「Header 取值符合基线」——
    // 后者仍是 CFG-HEADERS，保持未覆盖。不用代理证据冒充完整条款。
    rule: { kind: 'security-rules', ruleTokens: ['helmet-check'] },
  },
  {
    id: 'CFG-TLS',
    clause: 'ASVS 9.1',
    title: '传输加密与 TLS 配置',
    source: '安全中心 · TLS 配置检测（源码模式）',
    // 证据只到「源码里没有显式关闭证书校验/弱协议/弱套件」，
    // 不到「运行期与部署侧 TLS 已合规」—— 后者不在源码扫描可见范围，
    // 由规则 message 的限定语与页面的证据来源文案共同说明。
    rule: { kind: 'security-rules', ruleTokens: ['tls-config'] },
  },
  {
    id: 'DEP-CVE',
    clause: 'ASVS 12.1',
    title: '依赖漏洞（CVE / GHSA）',
    source: '依赖管家 · OSV 漏洞库',
    rule: { kind: 'deps-cve' },
  },
  {
    id: 'DEP-LOCKFILE',
    clause: 'ASVS 12.2',
    title: '锁文件完整性（声明与锁定一致）',
    source: '依赖管家 · 锁文件校验',
    rule: { kind: 'deps-lockfile' },
  },
  {
    id: 'DEP-TYPOSQUAT',
    clause: 'ASVS 12.3',
    title: '依赖投毒 / 仿冒包',
    source: '依赖管家 · 投毒检测',
    rule: { kind: 'deps-typosquat' },
  },
  // ── 尚未实现：只告知，不产出结论（能力边界的一部分） ──────────────
  {
    id: 'CFG-HEADERS',
    clause: 'ASVS 14.4',
    title: '安全响应头取值（CSP / HSTS / X-Frame-Options）',
    source: '暂无（中间件已安装不等于取值合规）',
    rule: { kind: 'uncovered' },
  },
  {
    id: 'AUTH-SESSION',
    clause: 'ASVS 2.2',
    title: '认证与会话策略',
    source: '暂无',
    rule: { kind: 'uncovered' },
  },
  {
    id: 'LOG-AUDIT',
    clause: 'ASVS 7.1',
    title: '审计日志与告警要求',
    source: '暂无',
    rule: { kind: 'uncovered' },
  },
  {
    id: 'KEY-ROTATION',
    clause: 'ASVS 2.10.4',
    title: '密钥生命周期与轮换',
    source: '暂无',
    rule: { kind: 'uncovered' },
  },
  {
    id: 'SUPPLY-SIGNATURE',
    clause: 'ASVS 12.5',
    title: '供应链完整性签名校验',
    source: '暂无',
    rule: { kind: 'uncovered' },
  },
];

export interface SecurityEvidence {
  ledger: ReadonlyArray<{
    ruleId: string;
    status: 'passed' | 'failed' | 'skipped' | 'error';
  }>;
  malwareTotal: number;
  /** 报告生成时间（ISO 8601）：过期证据必须看得见，否则旧结论会被读成本次结果 */
  generatedAt: string;
}

export interface DepsEvidence {
  /** null = 报告里没有 CVE 结果（未检测 ≠ 0 漏洞） */
  cve: { status: 'ok' | 'unavailable'; findings: number } | null;
  lockfile: { status: 'clean' | 'modified' | 'missing' } | null;
  /** null = 报告里没有投毒检测结果 */
  typosquatFindings: number | null;
  /** 报告生成时间（ISO 8601）：过期证据必须看得见 */
  generatedAt: string;
}

export interface ComplianceEvidence {
  security: SecurityEvidence | null;
  deps: DepsEvidence | null;
}

export interface ComplianceControlResult {
  id: string;
  clause: string;
  title: string;
  source: string;
  state: ComplianceState;
  /** 判定依据（含规则 id / 数量 / 原因），空证据时必须写明为什么不是通过 */
  detail: string;
}

export interface ComplianceReport {
  standard: typeof COMPLIANCE_STANDARD;
  controls: ComplianceControlResult[];
  summary: {
    pass: number;
    fail: number;
    noEvidence: number;
    uncovered: number;
    total: number;
  };
}

/** 安全报告 → 证据摘要；未落盘返回 null */
export function toSecurityEvidence(
  report: SecurityScanReportData | null | undefined,
): ComplianceEvidence['security'] {
  if (!report) return null;
  return {
    ledger: (report.ruleLedger ?? []).map((entry) => ({
      ruleId: entry.ruleId,
      status: entry.status,
    })),
    malwareTotal: report.summary.malwareTotal,
    generatedAt: report.metadata?.timestamp ?? '',
  };
}

/** 依赖报告 → 证据摘要；未落盘返回 null */
export function toDepsEvidence(
  report: DependencyReportData | null | undefined,
): ComplianceEvidence['deps'] {
  if (!report) return null;
  return {
    cve: report.cve ? { status: report.cve.status, findings: report.cve.findings.length } : null,
    lockfile: report.lockfileVerification
      ? { status: report.lockfileVerification.status }
      : null,
    typosquatFindings: Array.isArray(report.typosquatFindings)
      ? report.typosquatFindings.length
      : null,
    generatedAt: report.generatedAt ?? '',
  };
}

type Evaluation = { state: ComplianceState; detail: string };

/** 证据过期阈值：与门禁的快照口径一致（24h） —— 超期不改变判定，但必须打标 */
const SNAPSHOT_STALE_HOURS = 24;

/**
 * 证据时间注解：旧报告不能被读成本次结论。
 *
 * 合规视图吃的是**已落盘**的各域报告，用户很可能几天前扫过一次就再没跑；
 * 如果只显示“通过”，读起来像“刚刚验过”。所以通过/失败项一律回显报告时间与
 * 距今时长，超过 24h 追加「未重新检测」——与门禁纯判定的 snapshotNote 同一口径。
 */
function evidenceNote(generatedAt: string, now: number): string {
  if (!generatedAt) return '，未提供证据时间';
  const ts = Date.parse(generatedAt);
  if (!Number.isFinite(ts)) return '，证据时间无法解析';
  const hours = (now - ts) / 3_600_000;
  const local = new Date(ts).toLocaleString('zh-CN', { hour12: false });
  if (hours <= 0) return `，证据 ${local}`;
  const age =
    hours < 1 ? `${Math.max(1, Math.round(hours * 60))} 分钟前` : `${Math.round(hours)} 小时前`;
  const stale = hours >= SNAPSHOT_STALE_HOURS ? '，⚠️ 未重新检测' : '';
  return `，证据 ${local}（${age}${stale}）`;
}

type ControlBase = Pick<ComplianceControlResult, 'id' | 'clause' | 'title' | 'source'>;

function noEvidenceResult(base: ControlBase, detail: string): ComplianceControlResult {
  return { ...base, state: 'no-evidence', detail };
}

function evaluateSecurityRules(
  rule: Extract<ControlRule, { kind: 'security-rules' }>,
  security: SecurityEvidence,
): Evaluation {
  const matched = security.ledger.filter((entry) =>
    rule.ruleTokens.some((token) => entry.ruleId.includes(token)),
  );
  if (matched.length === 0) {
    return { state: 'no-evidence', detail: '安全报告无对应规则记录（未检测 ≠ 通过）' };
  }
  const failed = matched.filter(
    (entry) => entry.status === 'failed' || entry.status === 'error',
  );
  if (failed.length > 0) {
    return {
      state: 'fail',
      detail: `未通过：${failed.map((entry) => entry.ruleId).join('、')}`,
    };
  }
  const passed = matched.filter((entry) => entry.status === 'passed');
  if (passed.length === 0) {
    return {
      state: 'no-evidence',
      detail: `对应规则均被跳过（归属让位或缺工具）：${matched
        .map((entry) => entry.ruleId)
        .join('、')}`,
    };
  }
  return { state: 'pass', detail: `${passed.length} 条规则通过` };
}

function evaluateSecurityControl(
  base: ControlBase,
  rule: Extract<ControlRule, { kind: 'security-rules' | 'security-malware' }>,
  evidence: ComplianceEvidence,
  now: number,
): ComplianceControlResult {
  const security = evidence.security;
  if (!security) {
    return noEvidenceResult(base, '本次未落盘安全报告（未检测 ≠ 通过）');
  }
  const note = evidenceNote(security.generatedAt, now);
  if (rule.kind === 'security-malware') {
    const state = security.malwareTotal > 0 ? 'fail' : 'pass';
    const detail =
      state === 'fail'
        ? `检出 ${security.malwareTotal} 处恶意代码特征`
        : '未检出恶意代码特征';
    return { ...base, state, detail: `${detail}${note}` };
  }
  const result = evaluateSecurityRules(rule, security);
  if (result.state === 'no-evidence') return { ...base, ...result };
  return { ...base, ...result, detail: `${result.detail}${note}` };
}

function evaluateCve(base: ControlBase, deps: DepsEvidence): ComplianceControlResult {
  if (!deps.cve) {
    return noEvidenceResult(base, '依赖报告未包含 CVE 结果（未检测 ≠ 通过）');
  }
  if (deps.cve.status === 'unavailable') {
    return noEvidenceResult(base, '漏洞库不可达，本次未检测（≠ 0 漏洞）');
  }
  return deps.cve.findings > 0
    ? { ...base, state: 'fail', detail: `命中 ${deps.cve.findings} 个依赖漏洞` }
    : { ...base, state: 'pass', detail: '漏洞库查询完成，未命中' };
}

function evaluateLockfile(base: ControlBase, deps: DepsEvidence): ComplianceControlResult {
  if (!deps.lockfile) {
    return noEvidenceResult(base, '依赖报告未包含锁文件校验结果');
  }
  if (deps.lockfile.status === 'clean') {
    return { ...base, state: 'pass', detail: '锁文件与声明一致，完整性校验通过' };
  }
  return deps.lockfile.status === 'modified'
    ? { ...base, state: 'fail', detail: '锁文件与声明不一致' }
    : { ...base, state: 'fail', detail: '锁文件缺失' };
}

function evaluateTyposquat(base: ControlBase, deps: DepsEvidence): ComplianceControlResult {
  if (deps.typosquatFindings === null) {
    return noEvidenceResult(base, '依赖报告未包含投毒检测结果（未检测 ≠ 通过）');
  }
  return deps.typosquatFindings > 0
    ? { ...base, state: 'fail', detail: `命中 ${deps.typosquatFindings} 个可疑依赖` }
    : { ...base, state: 'pass', detail: '未命中仿冒/投毒依赖' };
}

function evaluateDepsControl(
  base: ControlBase,
  rule: Extract<ControlRule, { kind: 'deps-cve' | 'deps-lockfile' | 'deps-typosquat' }>,
  deps: DepsEvidence,
  now: number,
): ComplianceControlResult {
  const result =
    rule.kind === 'deps-cve'
      ? evaluateCve(base, deps)
      : rule.kind === 'deps-lockfile'
        ? evaluateLockfile(base, deps)
        : evaluateTyposquat(base, deps);
  if (result.state === 'no-evidence') return result;
  return { ...result, detail: `${result.detail}${evidenceNote(deps.generatedAt, now)}` };
}

function evaluateControl(
  control: ComplianceControl,
  evidence: ComplianceEvidence,
  now: number,
): ComplianceControlResult {
  const base: ControlBase = {
    id: control.id,
    clause: control.clause,
    title: control.title,
    source: control.source,
  };
  const rule = control.rule;
  if (rule.kind === 'uncovered') {
    return { ...base, state: 'uncovered', detail: '本页尚未实现该项检查，无证据源，不计为通过' };
  }
  if (rule.kind === 'security-rules' || rule.kind === 'security-malware') {
    return evaluateSecurityControl(base, rule, evidence, now);
  }
  const deps = evidence.deps;
  if (!deps) {
    return noEvidenceResult(base, '本次未落盘依赖报告（未检测 ≠ 通过）');
  }
  return evaluateDepsControl(base, rule, deps, now);
}

/** 按条款表评估合规差距；纯函数，无副作用（now 可注入以便测试过期标注） */
export function evaluateComplianceBaseline(
  evidence: ComplianceEvidence,
  now: number = Date.now(),
): ComplianceReport {
  const controls = COMPLIANCE_CONTROLS.map((control) => evaluateControl(control, evidence, now));
  const summary = {
    pass: controls.filter((control) => control.state === 'pass').length,
    fail: controls.filter((control) => control.state === 'fail').length,
    noEvidence: controls.filter((control) => control.state === 'no-evidence').length,
    uncovered: controls.filter((control) => control.state === 'uncovered').length,
    total: controls.length,
  };
  return { standard: COMPLIANCE_STANDARD, controls, summary };
}
