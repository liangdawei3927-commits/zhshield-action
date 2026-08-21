/**
 * 依赖管家数据模型（types.ts）
 *
 * 依赖图谱（DependencyGraph）是依赖管理域的唯一写入方，其他域（安全、评分、
 * 报告）只读消费。数据模型忠实对齐《08-商业化P0实现规格》附 B.2：
 * 看清（图谱）→ 信得过（锁文件哈希）→ 商用许可合规（许可证矩阵）。
 */

/** 归属 target 标识（多端并存各自一张图谱） */
export type TargetId = string;

/** 支持的包生态系统；mixed 表示未能识别单一生态（如空项目） */
export type Ecosystem = 'npm' | 'pip' | 'go' | 'maven' | 'mixed';

/** 包来源信息（registry + 发布者；离线静态分析场景通常缺失） */
export interface RegistrySource {
  /** 包来源 registry 地址，如 https://registry.npmjs.org/ */
  registry: string;
  /** 发布者（若可离线获取） */
  publisher?: string;
}

/**
 * 信任状态：
 * - verified    官方源 + 哈希匹配 + 发布者已知
 * - suspicious  typosquatting 命中 / 来源异常
 * - compromised 锁文件被改 / 哈希不匹配（最高危）
 * - unknown     信息不足（私有源等），不硬猜
 */
export type TrustStatus = 'verified' | 'suspicious' | 'compromised' | 'unknown';

/**
 * 漏洞引用：由安全域（trivy / osv）回写进图谱，本包不填充。
 * 依赖管家只负责展示，不重复扫描。
 */
export interface VulnerabilityRef {
  /** 漏洞编号，如 CVE-2024-XXXX */
  vulnId: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  /** 修复版本 */
  fixVersion?: string;
  /** 来源引擎 */
  source: 'trivy' | 'osv';
  /** 检出时间 */
  detectedAt: string;
}

/** 锁文件状态：存在性 / 与声明一致性 / 哈希完整性 */
export interface LockfileStatus {
  /** 锁文件是否存在（且可解析） */
  present: boolean;
  /** 锁文件与声明一致（无锁文件时为 false） */
  consistent: boolean;
  /** 哈希与官方发布一致（全部节点均带 integrity 视为通过） */
  integrityVerified: boolean;
  /** 最近修改时间（与基线对比用） */
  lastModified?: string;
}

/** 依赖图谱节点：单个依赖包及其来源 / 完整性 / 信任 / 漏洞引用信息 */
export interface DependencyNode {
  /** 节点唯一 id，形如 'lodash@4.17.21' */
  id: string;
  /** 包名，如 'lodash' */
  name: string;
  /** 锁定版本（以 lockfile 为准） */
  version: string;
  /** 声明范围，如 '^4.17.0'（传递依赖为 ''） */
  declaredRange: string;
  /** 最新版本（数据源可离线时缺失） */
  latestVersion?: string;
  /** direct：根清单直接声明；transitive：传递依赖 */
  kind: 'direct' | 'transitive';
  /** registry + 发布者（离线时缺失） */
  source?: RegistrySource;
  /** lockfile 哈希（sha512），如 'sha512-xxxx' */
  integrity?: string;
  trust: TrustStatus;
  /** 漏洞引用列表 —— 由安全域 trivy / osv 写入，当前恒为空数组 */
  vulnerabilities: VulnerabilityRef[];
  /** 包是否被官方标记废弃 */
  deprecated?: boolean;
  /** 许可证（lockfile 提供时为字符串，如 'MIT'） */
  license?: string;
}

/** 依赖边：from → to（requirement 为声明范围） */
export interface DependencyEdge {
  /** 依赖方 nodeId */
  from: string;
  /** 被依赖 nodeId */
  to: string;
  /** 声明范围 */
  requirement: string;
}

/** 依赖图谱：依赖管理域唯一写入方，其他域消费 */
export interface DependencyGraph {
  schemaVersion: 1;
  /** 归属 target（多端并存各自一张） */
  targetId: TargetId;
  ecosystem: Ecosystem;
  nodes: DependencyNode[];
  edges: DependencyEdge[];
  lockfile: LockfileStatus;
  /** 生成时间（ISO 8601） */
  generatedAt: string;
}

/** 图谱根节点 id 约定：对应项目本身（隐含节点，不入 nodes） */
export const ROOT_NODE_ID = '@root';

/** 图谱根节点显示名 */
export const ROOT_NODE_NAME = '<root>';
