/**
 * 检测能力注册表 —— 「宣称什么」与「实现什么」的唯一对照表。
 *
 * ## 要解决什么
 *
 * 2026-11-02 代码审计发现的第二类信任缺口：**UI 宣称的能力没有对应实现**。
 *
 * 实测样本：
 *   · 性能页空态宣称 4 项能力（运行时复杂度 / ReDoS 检测 / 现代化 API / 定时器优化），
 *     实际探测器只覆盖其中部分 —— ReDoS 曾是**死资产**（redos.yml 无规则引用），
 *     已于 2026-11-03 以原生 RedosDetectorImpl 落地并转 implemented；
 *     「现代化 API」「定时器优化」仍无任何探测器（planned）。
 *   · 安全页空态宣称「规范检查」（`page.security.feature.standard`），
 *     全仓搜不到任何实现。
 *   · 垃圾页空态宣称「重复代码」，但按《07》O1 契约重复代码已唯一归重构域。
 *
 * 这类问题的形态与「规则断链」完全一致：**用户看到的能力清单与真实能力不符，
 * 且没有任何异常提示**。用户不会觉得功能坏了，反而会以为代码没问题。
 *
 * ## 设计
 *
 * 本表把「一个域到底有哪些能力」显式化，每条能力带三个字段：
 *   · `id` —— 稳定标识（`performance.runtime.nested-loop` 这种，带域前缀）
 *   · `implementedBy` —— **实现证据**：该能力由哪些标识符承载
 *     （SOP 规则 id / 探测器 ruleId 前缀 / 坏味道类型）
 *   · `status` —— `implemented` | `planned` | `deprecated`
 *
 * `status` 的语义（关键）：
 *   · `implemented` —— **有实现**，且能对应到真实标识符。UI 可以宣称它。
 *   · `planned`     —— 尚未实现。**UI 不得宣称**（否则就是骗用户）。
 *   · `deprecated`  —— 曾实现、现已移交他域（如重复代码移交重构域）。UI 不得宣称。
 *
 * ## 谁消费它
 *
 *   1. **UI**：空态 `features` 数组只允许渲染 `implemented` 的能力。
 *      渲染层不做判断（判断在渲染层就意味着会有第二份口径）。
 *   2. **测试**：断言「所有 `implemented` 能力的 `implementedBy` 都能在真实代码里找到」
 *      —— 能力清单与实现不会悄悄漂移。
 *   3. **CLI**：`zhshield capability` 把本表的缺口一并列出。
 *
 * ## 为什么放在 @zh/shared
 *
 * 因为**桌面端（声明方）与各引擎（实现方）都要读它** —— 桌面端不能依赖
 * `@zh/kernel`（那会让 kernel 反向依赖桌面端），而引擎包也不该依赖桌面端。
 * `@zh/shared` 是唯一双方都已依赖的包，且它**零第三方依赖**（只依赖 @zh/i18n）。
 */

import type { DomainId } from './domain-contract/types';

/** 能力状态 */
export type CapabilityStatus =
  /** 有实现：UI 可以宣称 */
  | 'implemented'
  /** 尚未实现：UI 不得宣称（宣称即欺骗） */
  | 'planned'
  /** 已移交他域：UI 不得宣称 */
  | 'deprecated';

/** 一条检测能力声明 */
export interface CapabilityDeclaration {
  /** 稳定标识（带域前缀，全局唯一） */
  id: string;
  /** 所属治理域 */
  domain: DomainId;
  /** 能力名（人类可读，中文） */
  label: string;
  /** 状态 */
  status: CapabilityStatus;
  /**
   * 实现证据：承载该能力的标识符。
   *
   * 形状随实现形态而异，由各域自行约定：
   *   · SOP 规则驱动的域 → SOP 规则 id（如 `security.scan.semgrep.sql-injection`）
   *   · 原生探测器驱动的域 → 探测器 ruleId 前缀（如 `performance.runtime`）
   *   · 坏味道驱动的域 → 坏味道类型（如 `duplicated-code`）
   *
   * `implemented` 状态的条目**不得为空** —— 声明了却给不出实现证据，
   * 等于没声明。
   */
  implementedBy: readonly string[];
  /** 备注：为什么 planned / deprecated */
  note?: string;
}

/**
 * 能力注册表（单一事实源）。
 *
 * 新增能力时：**先写实现，再在此登记** —— 顺序反了就会出现
 * 「UI 宣称了但没有实现」的缺口，而这正是本表要消灭的东西。
 */
export const CAPABILITY_REGISTRY: readonly CapabilityDeclaration[] = [
  // ─── 性能优化域 ──────────────────────────────────────────────────────────
  {
    id: 'performance.runtime.nested-loop',
    domain: 'performance',
    label: '运行时复杂度（嵌套循环 / 同步阻塞 IO）',
    status: 'implemented',
    implementedBy: ['performance.runtime.nested-loop', 'performance.runtime.sync-io'],
  },
  {
    id: 'performance.build-config',
    domain: 'performance',
    label: '构建配置（压缩 / sourcemap / mode）',
    status: 'implemented',
    implementedBy: ['build-config'],
  },
  {
    id: 'performance.bundle-size',
    domain: 'performance',
    label: '产物体积',
    status: 'implemented',
    implementedBy: ['bundle-size'],
  },
  {
    id: 'performance.tree-shaking',
    domain: 'performance',
    label: 'Tree-shaking / 代码分割',
    status: 'implemented',
    implementedBy: ['tree-shaking', 'chunk-splitting'],
  },
  {
    id: 'performance.redos',
    domain: 'performance',
    label: 'ReDoS 检测（正则灾难性回溯）',
    status: 'implemented',
    implementedBy: ['performance.redos'],
    note:
      '由 @zh/performance 的原生 RedosDetectorImpl 实现（TS AST 静态分析嵌套不定量词），' +
      '随 runPerformanceDomain 在桌面端真实执行 —— 不依赖 semgrep 二进制，未装工具也能查。' +
      '内核 redos.yml 是 semgrep 形态的等价资产，保留给 CLI/CI 可选使用，但桌面端以原生探测器为准 ' +
      '（性能域走 domain-executor，不经 SOP 规则引擎，故 semgrep 规则在此不会被执行）。',
  },
  {
    id: 'performance.modern-api',
    domain: 'performance',
    label: '现代化 API 推荐（.at / spread）',
    status: 'planned',
    implementedBy: [],
    note: '尚无探测器。',
  },
  {
    id: 'performance.timer',
    domain: 'performance',
    label: '定时器优化（setTimeout / setInterval 滥用）',
    status: 'planned',
    implementedBy: [],
    note: '尚无探测器。',
  },

  // ─── 安全中心域 ──────────────────────────────────────────────────────────
  {
    id: 'security.vuln.sql-injection',
    domain: 'security',
    label: 'SQL 注入检测',
    status: 'implemented',
    implementedBy: ['security.scan.semgrep.sql-injection'],
  },
  {
    id: 'security.vuln.xss',
    domain: 'security',
    label: 'XSS 检测',
    status: 'implemented',
    implementedBy: ['security.scan.semgrep.xss'],
  },
  {
    id: 'security.vuln.command-injection',
    domain: 'security',
    label: '命令注入检测',
    status: 'implemented',
    implementedBy: ['security.scan.semgrep.command-injection'],
  },
  {
    id: 'security.vuln.csrf',
    domain: 'security',
    label: 'CSRF 检测',
    status: 'implemented',
    implementedBy: ['security.scan.semgrep.csrf'],
  },
  {
    id: 'security.vuln.path-traversal',
    domain: 'security',
    label: '路径穿越检测',
    status: 'implemented',
    implementedBy: ['security.scan.semgrep.path-traversal'],
  },
  {
    id: 'security.secrets',
    domain: 'security',
    label: '硬编码密钥检测',
    status: 'implemented',
    implementedBy: ['security.scan.gitleaks.hardcoded-key'],
  },
  {
    id: 'security.malware',
    domain: 'security',
    label: '恶意代码特征（反弹 Shell / 后门 / 供应链投毒）',
    status: 'implemented',
    // 实现证据是**恶意代码类型**（@zh/security 的启发式正则通道产出），
    // 不是 SOP 规则 id —— 那 3 条同名 SOP 规则是 draft/trial，从不求值。
    // 这里写错会让「实现证据可达」校验红，正是该校验存在的意义。
    implementedBy: [
      'reverse-shell',
      'backdoor',
      'supply-chain',
      'data-exfiltration',
      'privilege-escalation',
      'crypto-ransomware',
    ],
    note:
      '由 @zh/security 的启发式正则通道实现（malware-scanner / injection-guard），' +
      '不依赖 SOP 规则求值；同名 SOP 规则（security.scan.malware.*）仍是 draft/trial。',
  },
  {
    id: 'security.standard',
    domain: 'security',
    label: '安全编码规范与合规基线校验',
    status: 'planned',
    implementedBy: [],
    note: '全仓无对应实现。安全页空态不得宣称此项。',
  },
  {
    id: 'security.dependency',
    domain: 'security',
    label: '依赖 CVE 检测',
    status: 'deprecated',
    implementedBy: [],
    note:
      '按《07》O2 / O10 唯一归依赖管家（OSV），安全域不再二次上报。' +
      '安全页空态不得宣称此项；依赖页负责。',
  },

  // ─── 垃圾清理域 ──────────────────────────────────────────────────────────
  {
    id: 'garbage.unused-file',
    domain: 'garbage',
    label: '无用文件与残留产物',
    status: 'implemented',
    implementedBy: ['garbage.detect.fs'],
  },
  {
    id: 'garbage.dead-code',
    domain: 'garbage',
    label: '死代码（未使用的导出）',
    status: 'implemented',
    implementedBy: ['garbage.scan.cleanup.dead-code'],
  },
  {
    id: 'garbage.unused-dependency',
    domain: 'garbage',
    label: '未使用依赖',
    status: 'implemented',
    implementedBy: ['garbage.scan.cleanup.unused-dependency'],
  },
  {
    id: 'garbage.duplicate-code',
    domain: 'garbage',
    label: '重复代码',
    status: 'deprecated',
    implementedBy: [],
    note: '按《07》O1 唯一归重构域。垃圾页空态不得宣称此项。',
  },

  // ─── 代码重构域 ──────────────────────────────────────────────────────────
  {
    id: 'refactor.duplicate-code',
    domain: 'refactor',
    label: '重复代码',
    status: 'implemented',
    implementedBy: ['duplicated-code'],
  },
  {
    id: 'refactor.smells',
    domain: 'refactor',
    label: '代码异味（过长函数 / 圈复杂度 / 深层嵌套）',
    status: 'implemented',
    implementedBy: ['long-method', 'deep-nesting', 'large-class', 'god-object'],
  },
  {
    id: 'refactor.auto-fix',
    domain: 'refactor',
    label: '一键应用推荐重构方案',
    status: 'implemented',
    // 实现证据 = 存在修复生成器（且检测器把它标为 autoFixable）的高置信坏味道类型。
    // 现这两类既有检测器（ruleId 可达），又有 auto-fix 生成器（auto-fix.ts 的 FIX_GENERATORS）。
    implementedBy: ['inappropriate-intimacy', 'callback-hell'],
    note:
      '由 @zh/refactor 的 auto-fix 生成器（generateFixes/applyFixes）+ 桌面端「一键应用」链路实现：' +
      '主进程子进程内扫描→生成补丁→**备份到 .zhshield/backups/refactor-autofix-<时间戳>/**→写盘，可整目录回滚；' +
      '写盘前强制目标文件位于项目根内（越界修复拒绝写入）。' +
      '覆盖两类高置信坏味道：封装性 inappropriate-intimacy、回调地狱 callback-hell；' +
      '硬编码字符串 shotgun-surgery 因无法安全替换各使用点（检测仅记录出现文件、不记录使用点位置），已降级为建议、不自动改写。',
  },

  // ─── 项目体检域 ──────────────────────────────────────────────────────────
  {
    id: 'inspect.architecture',
    domain: 'inspect',
    label: '架构规范（循环依赖 / 分层边界 / 模块依赖）',
    status: 'implemented',
    implementedBy: [
      'inspect.scan.depcruiser.circular-dependency',
      'inspect.scan.depcruiser.layer-boundary',
      'inspect.scan.depcruiser.module-dependency',
    ],
  },
  {
    id: 'inspect.type-safety',
    domain: 'inspect',
    label: '类型安全（真实 tsc 检查 + 空安全 / 类型一致性）',
    status: 'implemented',
    implementedBy: [
      'inspect.scan.typescript.type-error-check',
      'inspect.scan.internal.null-safety',
      'inspect.scan.internal.type-consistency',
      'inspect.scan.internal.type-safety',
    ],
  },
  {
    id: 'inspect.code-style',
    domain: 'inspect',
    label: '代码规范（严格模式 / 枚举使用）',
    status: 'implemented',
    implementedBy: ['inspect.scan.internal.strict-mode', 'inspect.scan.internal.enum-usage'],
  },
  {
    id: 'inspect.module-boundary',
    domain: 'inspect',
    label: '模块边界与依赖注入合规',
    status: 'implemented',
    implementedBy: [
      'inspect.scan.ironnest.dependency-injection',
      'inspect.scan.ironnest.module-boundary',
      'inspect.scan.depcruiser.layer-boundary',
    ],
  },
  {
    id: 'inspect.compliance',
    domain: 'inspect',
    label: '合规基线（ASVS L1 子集）',
    status: 'implemented',
    // 实现证据是桌面端只读映射器（packages/desktop/src/compliance/baseline.ts）：
    // 它把各域已落盘结论按标准条款汇总成四态，不启动任何扫描 —— 合规是**视图**，
    // 不是新的检测面，故证据不是 SOP 规则 id。
    implementedBy: ['compliance-baseline'],
  },
];

/** 按域索引的能力清单（构建期一次性派生，不手写第二份） */
export const CAPABILITIES_BY_DOMAIN: ReadonlyMap<DomainId, readonly CapabilityDeclaration[]> =
  CAPABILITY_REGISTRY.reduce((map, cap) => {
    const list = map.get(cap.domain) ?? [];
    list.push(cap);
    map.set(cap.domain, list);
    return map;
  }, new Map<DomainId, CapabilityDeclaration[]>());

/** 某域已实现的能力（UI 可宣称的部分） */
export function implementedCapabilities(domain: DomainId): readonly CapabilityDeclaration[] {
  return (CAPABILITIES_BY_DOMAIN.get(domain) ?? []).filter((c) => c.status === 'implemented');
}

/** 某域未实现的能力（UI 不得宣称的部分） */
export function unimplementedCapabilities(domain: DomainId): readonly CapabilityDeclaration[] {
  return (CAPABILITIES_BY_DOMAIN.get(domain) ?? []).filter((c) => c.status !== 'implemented');
}

/**
 * 找出「声明为已实现、但没给出实现证据」的能力。
 *
 * 这类条目等于「宣称有、但指不出在哪」—— 与 UI 宣称无实现是同一类缺陷，
 * 必须在编译期/测试期拦住。
 */
export function findCapabilitiesWithoutEvidence(
  registry: readonly CapabilityDeclaration[] = CAPABILITY_REGISTRY,
): CapabilityDeclaration[] {
  return registry.filter((c) => c.status === 'implemented' && c.implementedBy.length === 0);
}
