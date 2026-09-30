/**
 * @zh/garbage — 垃圾清理域类型
 *
 * 本包是「垃圾清理」分类的能力 owner（设计见 04-架构重建蓝图；
 * 方案文档《导航各司其职》T5）。检测项与判定口径均在此包内定义，
 * 不借用安全引擎：安全中心只做漏洞 / 恶意代码 / 密钥，不产出垃圾清单。
 */
import type { GarbageItem } from '@zh/shared';

/** 垃圾类型（与 @zh/shared GarbageItem.type 同源，此处仅作别名方便使用） */
export type GarbageType = GarbageItem['type'];

export type { GarbageItem };

/** 移入回收站的入参（渲染进程 → 主进程透传，字段与页面勾选结果一致） */
export interface GarbageCleanInput {
  id: string;
  path: string;
  size: number;
  type: string;
  reason?: string;
}

/** 移入回收站的结果：批次 ID、成功清理的条目、释放字节数与失败原因列表 */
export interface GarbageCleanResult {
  batchId: string;
  cleaned: GarbageItem[];
  freedBytes: number;
  failed: string[];
}

/** 回收站恢复结果：恢复条数、恢复字节数与失败原因列表 */
export interface GarbageRestoreResult {
  restored: number;
  restoredBytes: number;
  failed: string[];
}

/** 单项检测的执行状态 —— 用来区分「跑过且无命中」与「压根没跑」 */
export interface GarbageCheckStatus {
  ruleId: string;
  name: string;
  /** 是否真正执行（false = 工具不可用 / 规则空跑 / 执行异常） */
  ran: boolean;
  /** 该项由谁产出：文件系统检测器 or SOP 规则 */
  producer: 'detector' | 'sop-rule';
  /** 未执行时的原因（工具不可用 / 报错信息） */
  reason?: string;
}

/** 垃圾清理扫描报告（页面唯一数据源，不再借用 SecurityScanReport） */
export interface GarbageScanReport {
  projectPath: string;
  items: GarbageItem[];
  summary: {
    total: number;
    /** 可释放字节数（仅计入有 size 的项：构建产物 / 垃圾文件） */
    size: number;
    byType: Record<string, number>;
  };
  /** 各检测项执行状态；未执行项必须在页面显式提示，禁止静默当"通过" */
  checks: GarbageCheckStatus[];
  /** 未真正执行的检测数 */
  skipped: number;
  timestamp: string;
}
