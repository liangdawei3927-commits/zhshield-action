/**
 * 垃圾清理扫描报告组装（垃圾清理域的唯一判定出口）
 *
 * 数据来源两类，合并为一份报告：
 *   1) 文件系统检测器（detectFsGarbage）—— 构建产物 / 垃圾文件 / 空文件；
 *   2) garbage 域 SOP 规则求值结果 —— 死代码 / 重复代码 / 未使用依赖。
 *
 * 诚实性约束：任一检测项未真正执行（工具不可用 / 规则空跑 / 执行异常）都必须
 * 出现在 checks 中且 ran=false，并计入 skipped —— 页面据此提示"未完成的检测"，
 * 避免「什么都没查」显示成「没有垃圾」。
 */
import type { GarbageItem, GarbageCheckStatus, GarbageScanReport } from './types';
import {
  issuesToGarbageItems,
  mapRuleIdToGarbageType,
  type GarbageViolationLike,
} from './item-mapper';

/** 文件系统检测器的固定 id（非 SOP 规则，故单列） */
export const FS_DETECTOR_ID = 'garbage.detect.fs';

/** 规则求值结果的最小结构（与 kernel RuleEvaluation 结构兼容，不引入 kernel 依赖） */
export interface GarbageEvaluationLike {
  rule: { id: string; name?: string };
  /** passed | failed | skipped | error */
  status: string;
  message?: string;
  degraded?: boolean;
  violations?: GarbageViolationLike[];
}

export interface BuildGarbageReportInput {
  projectPath: string;
  /** 文件系统检测器产出 */
  fsItems: GarbageItem[];
  /** garbage 域各规则求值结果（缺省表示该次未跑规则通道） */
  evaluations?: GarbageEvaluationLike[];
  /** 该次是否跑了规则通道（用于区分"没有规则"与"规则通道异常"） */
  ruleChannelRan?: boolean;
  now?: () => Date;
}

export function buildGarbageReport(input: BuildGarbageReportInput): GarbageScanReport {
  const { projectPath, fsItems, evaluations = [], ruleChannelRan = true } = input;
  const now = input.now ?? (() => new Date());

  const checks: GarbageCheckStatus[] = [
    {
      ruleId: FS_DETECTOR_ID,
      name: '文件系统级垃圾（构建产物 / 垃圾文件 / 空文件）',
      ran: true,
      producer: 'detector',
    },
  ];

  const items: GarbageItem[] = [...fsItems];

  if (!ruleChannelRan) {
    checks.push({
      ruleId: 'garbage.rules',
      name: '垃圾规则通道',
      ran: false,
      producer: 'sop-rule',
      reason: '规则通道未执行（引擎装配或规则加载异常）',
    });
  }

  const unmapped = new Set<string>();
  for (const evaluation of evaluations) {
    const ruleId = evaluation.rule?.id ?? '';
    const executed = evaluation.status === 'passed' || evaluation.status === 'failed';
    const ran = executed && evaluation.degraded !== true;
    checks.push({
      ruleId,
      name: evaluation.rule?.name || ruleId,
      ran,
      producer: 'sop-rule',
      reason: ran ? undefined : evaluation.message || `规则未执行（${evaluation.status}）`,
    });
    if (!ran) continue;

    for (const violation of evaluation.violations ?? []) {
      if (mapRuleIdToGarbageType(violation.ruleId) === null) {
        unmapped.add(violation.ruleId);
        continue;
      }
    }
    items.push(...issuesToGarbageItems(evaluation.violations ?? []));
  }

  // 未登记映射的规则：产出被丢弃时必须显式记账（防"规则跑了但页面看不到"）
  for (const ruleId of unmapped) {
    checks.push({
      ruleId,
      name: `未登记映射的规则产出：${ruleId}`,
      ran: false,
      producer: 'sop-rule',
      reason: '该规则产出的条目未在 item-mapper 映射表登记，已丢弃（需补登记）',
    });
  }

  const byType: Record<string, number> = {};
  let size = 0;
  for (const item of items) {
    byType[item.type] = (byType[item.type] ?? 0) + 1;
    size += item.size || 0;
  }

  return {
    projectPath,
    items: sortItems(items),
    summary: { total: items.length, size, byType },
    checks,
    skipped: checks.filter((c) => !c.ran).length,
    timestamp: now().toISOString(),
  };
}

/** 排序：体积大的优先（清理收益高），同体积按路径稳定排序 */
function sortItems(items: GarbageItem[]): GarbageItem[] {
  return [...items].sort((a, b) => {
    if (b.size !== a.size) return b.size - a.size;
    return a.path.localeCompare(b.path);
  });
}
