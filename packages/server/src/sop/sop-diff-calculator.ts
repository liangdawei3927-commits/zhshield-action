import * as crypto from 'node:crypto';
import type { SopRegistry, SopRule, SopDiff } from '@zh/kernel';

const VERSION_DATE = /(\d{4})\.(\d{2})\.(\d{2})/;

/**
 * SopDiffCalculator — SOP 规则差异计算器
 *
 * 聚焦单一职责：计算两个版本之间的规则差异（增量更新）。
 * 从 SopService 拆分而来，以消除 large-class（方法数过多）问题。
 */
export class SopDiffCalculator {
  computeDiff(registry: SopRegistry, fromVersion: string, toVersion: string): SopDiff {
    const allRules = registry.getAll();
    const activeRules = registry.getActive();

    const { unchanged, modified, removed } = this.classifyRules(allRules, fromVersion);
    const added = this.findAddedRules(activeRules, unchanged, modified);
    const { diffContent, hash } = this.buildDiffSummary(added, modified, removed);

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

  private classifyRules(allRules: SopRule[], fromVersion: string): { unchanged: string[]; modified: SopRule[]; removed: string[] } {
    const unchanged: string[] = [];
    const modified: SopRule[] = [];
    const removed: string[] = [];

    // 按规则 updatedAt 判断变更
    for (const rule of allRules) {
      if (rule.status === 'deprecated') {
        removed.push(rule.id);
      } else if (this.wasModifiedSince(rule, fromVersion)) {
        modified.push(rule);
      } else {
        unchanged.push(rule.id);
      }
    }

    return { unchanged, modified, removed };
  }

  // 新增的规则（注册时间较晚）
  private findAddedRules(activeRules: SopRule[], unchanged: string[], modified: SopRule[]): SopRule[] {
    const added: SopRule[] = [];
    for (const rule of activeRules) {
      if (!unchanged.includes(rule.id) && !modified.some((m) => m.id === rule.id)) {
        added.push(rule);
      }
    }
    return added;
  }

  // 简化版本差异计算：比较规则内容哈希
  private buildDiffSummary(added: SopRule[], modified: SopRule[], removed: string[]): { diffContent: string; hash: string } {
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
}
