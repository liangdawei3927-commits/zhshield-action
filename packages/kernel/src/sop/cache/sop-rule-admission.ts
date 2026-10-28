import type { SopRule } from '../_meta/sop-types';
import {
  validateBuiltRule,
  normalizeTags,
  logIssues,
  type SopRuleIssue,
} from '../_meta/sop-field-validation';

/** 云端下发路径的问题归因标识（配合诊断面板区分「文件加载」与「云端同步」） */
export const CLOUD_SYNC_ORIGIN = 'cloud-sync';

/**
 * 云端规则准入器 — 规则进入 registry 前的唯一关口。
 *
 * 原实现由各调用点直接 `registry.register` / `registry.loadAll`，字段全靠类型断言，
 * 于是云端下发 `status: "actived"` 会让规则进 registry 却永不匹配 `getActive()`
 * —— **静默空跑且本地零告警**，还会被持久化进本地缓存，下次启动继续携带。
 *
 * 从 `SopSyncCoordinator` 抽出的独立协作者：协调器负责编排，准入规则只此一处判定。
 */
export class SopRuleAdmission {
  private issues: SopRuleIssue[] = [];

  /** 累计的拒收/纠正问题（`file` 为 `cloud-sync:<ruleId>`，可直接定位到规则） */
  getIssues(): readonly SopRuleIssue[] {
    return this.issues;
  }

  clearIssues(): void {
    this.issues = [];
  }

  /**
   * 接纳一条规则：非法则拒收并留痕，可纠正则归一化后放行。
   *
   * @returns 可入库的规则；`null` 表示已拒收
   */
  admit(rule: SopRule): SopRule | null {
    const issues = validateBuiltRule(rule, CLOUD_SYNC_ORIGIN);
    if (issues.length === 0) return rule;

    this.issues.push(...issues);
    logIssues(issues);
    if (issues.some((i) => i.level === 'fatal')) return null;

    const tagIssue = issues.find((i) => i.field === 'tags');
    return tagIssue ? { ...rule, tags: normalizeTags(tagIssue.value) } : rule;
  }

  /** 批量接纳：逐条校验并丢弃非法项 */
  admitAll(rules: readonly SopRule[]): SopRule[] {
    const accepted: SopRule[] = [];
    for (const rule of rules) {
      const admitted = this.admit(rule);
      if (admitted) accepted.push(admitted);
    }
    return accepted;
  }
}
