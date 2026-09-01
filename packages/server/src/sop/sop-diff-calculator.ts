import * as crypto from 'node:crypto';
import type { SopRegistry, SopRule, SopDiff } from '@zh/kernel';

const VERSION_DATE = /(\d{4})\.(\d{2})\.(\d{2})/;

/**
 * 规则哈希变体（二.2 三哈希方案）：
 * - content：语义内容哈希（排除误报计数、时间戳等易变字段），用于精确判定规则是否实质变更
 * - sha256：完整规则的 SHA-256（含全部字段）
 * - quick：djb2 快速指纹（非加密，仅用于低成本预比对）
 */
export type RuleHashVariant = 'content' | 'sha256' | 'quick';

export interface RuleHashes {
  content: string;
  sha256: string;
  quick: string;
}

const MAX_STORED_VERSIONS = 10;

/** 递归键排序的规范化 JSON（同值同串，与键序无关） */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function sha256Hex(data: string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** djb2 变体快速指纹 → 8 位十六进制（碰撞敏感，只做预比对） */
function quickFingerprint(data: string): string {
  let h = 5381;
  for (let i = 0; i < data.length; i++) {
    h = ((h << 5) + h + data.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * SopDiffCalculator — SOP 规则差异计算器
 *
 * 聚焦单一职责：计算两个版本之间的规则差异（增量更新）。
 * 从 SopService 拆分而来，以消除 large-class（方法数过多）问题。
 *
 * 三哈希方案（二.2）：computeRuleHash 为每条规则产出 content/sha256/quick 三重哈希，
 * storeVersionHashes 按版本留存快照，getStoredHash 查询；classifyRules 在存在
 * 来源版本快照时改用内容哈希精确比对，替代 updatedAt 启发式。
 */
export class SopDiffCalculator {
  private versionHashes = new Map<string, Map<string, RuleHashes>>();

  computeDiff(registry: SopRegistry, fromVersion: string, toVersion: string): SopDiff {
    const allRules = registry.getAll();
    const activeRules = registry.getActive();

    const { unchanged, modified, removed } = this.classifyRules(allRules, fromVersion);
    const added = this.findAddedRules(activeRules, unchanged, modified);
    const { diffContent, hash } = this.buildDiffSummary(added, modified, removed);

    this.storeVersionHashes(toVersion, this.hashAll(allRules));

    return {
      version: toVersion,
      fromVersion,
      compatibility: '>=0.1.0',
      added,
      removed,
      modified,
      unchanged,
      metadata: {
        totalRules: allRules.length,
        diffSize: Buffer.byteLength(diffContent, 'utf-8'),
        hash,
      },
    };
  }

  /**
   * 计算单条规则的三重哈希（content / sha256 / quick）
   */
  computeRuleHash(rule: SopRule): RuleHashes {
    const contentData = canonicalJson(semanticContent(rule));
    const fullData = canonicalJson(rule);
    const sha256 = sha256Hex(fullData);
    return {
      content: sha256Hex(contentData),
      sha256,
      quick: quickFingerprint(sha256),
    };
  }

  /**
   * 留存指定版本的规则哈希快照（供后续差异计算精确比对）
   */
  storeVersionHashes(version: string, hashes: ReadonlyMap<string, RuleHashes>): void {
    this.versionHashes.delete(version);
    this.versionHashes.set(version, new Map(hashes));
    while (this.versionHashes.size > MAX_STORED_VERSIONS) {
      const oldest = this.versionHashes.keys().next().value;
      if (oldest === undefined) break;
      this.versionHashes.delete(oldest);
    }
  }

  /**
   * 查询某版本快照中指定规则的哈希（默认 content 变体）
   */
  getStoredHash(
    version: string,
    ruleId: string,
    variant: RuleHashVariant = 'content',
  ): string | undefined {
    return this.versionHashes.get(version)?.get(ruleId)?.[variant];
  }

  private classifyRules(
    allRules: SopRule[],
    fromVersion: string,
  ): { unchanged: string[]; modified: SopRule[]; removed: string[] } {
    const unchanged: string[] = [];
    const modified: SopRule[] = [];
    const removed: string[] = [];
    const stored = this.versionHashes.get(fromVersion);

    for (const rule of allRules) {
      if (rule.status === 'deprecated') {
        removed.push(rule.id);
      } else if (this.isModified(rule, fromVersion, stored)) {
        modified.push(rule);
      } else {
        unchanged.push(rule.id);
      }
    }

    return { unchanged, modified, removed };
  }

  /** 有来源版本快照时按内容哈希精确比对；否则回退 updatedAt 启发式 */
  private isModified(
    rule: SopRule,
    fromVersion: string,
    stored: ReadonlyMap<string, RuleHashes> | undefined,
  ): boolean {
    const previous = stored?.get(rule.id);
    if (!previous) return stored ? true : this.wasModifiedSince(rule, fromVersion);
    return previous.content !== this.computeRuleHash(rule).content;
  }

  // 新增的规则（注册时间较晚）：Set 成员查找，O(n) 取代旧嵌套扫描的 O(n²)
  private findAddedRules(
    activeRules: SopRule[],
    unchanged: string[],
    modified: SopRule[],
  ): SopRule[] {
    const knownIds = new Set<string>(unchanged);
    for (const rule of modified) {
      knownIds.add(rule.id);
    }
    const added: SopRule[] = [];
    for (const rule of activeRules) {
      if (!knownIds.has(rule.id)) {
        added.push(rule);
      }
    }
    return added;
  }

  // 简化版本差异计算：比较规则内容哈希
  private buildDiffSummary(
    added: SopRule[],
    modified: SopRule[],
    removed: string[],
  ): { diffContent: string; hash: string } {
    const diffContent = JSON.stringify({ added, modified, removed });
    const hash = crypto.createHash('sha256').update(diffContent).digest('hex');
    return { diffContent, hash };
  }

  private wasModifiedSince(rule: SopRule, version: string): boolean {
    // 从版本号提取日期 YYYY.MM.DD
    const dateMatch = version.match(VERSION_DATE);
    if (!dateMatch) return false;

    const versionDate = new Date(
      parseInt(dateMatch[1], 10),
      parseInt(dateMatch[2], 10) - 1,
      parseInt(dateMatch[3], 10),
    );

    return rule.updatedAt > versionDate;
  }

  private hashAll(rules: readonly SopRule[]): Map<string, RuleHashes> {
    const map = new Map<string, RuleHashes>();
    for (const rule of rules) {
      map.set(rule.id, this.computeRuleHash(rule));
    }
    return map;
  }
}

/** 参与内容哈希的语义字段；误报计数与时间戳等易变元数据不参与（保证计数噪声不触发 modified） */
function semanticContent(rule: SopRule): Record<string, unknown> {
  const {
    id,
    name,
    domain,
    action,
    source,
    description,
    status,
    executionMode,
    severity,
    applicableEngines,
    content,
    serves,
    tags,
  } = rule;
  return {
    id,
    name,
    domain,
    action,
    source,
    description,
    status,
    executionMode,
    severity,
    applicableEngines,
    content,
    serves,
    tags,
  };
}
