/**
 * 仪表盘聚合数据层（ipc/dashboard-state.ts）
 *
 * 维护 .zhshield/dashboard-state.json：deps / secrets / techdebt / refactor / performance / garbage
 * 各域的最新统计摘要 + lastRunAt。
 *
 * 消费方：`buildPipelineExtras`（engines.ts）—— 汇总生成报告时组装 @zh/scoring 的
 * `DimensionExtras`，使报告中心的分与 pipeline 的分同口径（没跑过的域为 null → 该维度 not-run）。
 *
 * 写入遵循串行化队列（对齐 zh-diagnostics.ts writeQueue 模式），
 * 写入失败静默降级（catch 打 warn），不阻塞主流程。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// ─── 类型定义 ─────────────────────────────────────────────────────

/** 依赖域聚合数据（提取口径见 runDepsDashboardPatch 注释） */
export interface DashboardDepsState {
  /**
   * 漏洞 severity 计数：
   * - critical = trustCounts.compromised ?? 0（被攻陷依赖节点）
   * - high = trustCounts.suspicious ?? 0（可疑依赖节点）
   * - medium = typosquatFindings 中 risk='medium' 的投毒发现数
   */
  vulnerabilities: { critical: number; high: number; medium: number };
  /** 可升级依赖数：upgradeAssessments 中 candidates.length > 0 的依赖数 */
  upgradable: number;
  /**
   * P1-8：CVE 检测状态。unavailable = 漏洞库不可达、本次未检测（计数恒 0 但**不是**安全），
   * 前端必须显示降级提示；旧数据无此字段（undefined）按未检测对待。
   */
  cve?: { status: 'ok' | 'unavailable'; critical: number; high: number; medium: number };
  lastRunAt: string;
}

/** 密钥域聚合数据 */
export interface DashboardSecretsState {
  /** 活跃未处理密钥数：来自 SecretReportData.summary.active */
  activeCount: number;
  lastRunAt: string;
}

/** 技术债务域聚合数据 */
export interface DashboardTechDebtState {
  /** 债务指数 0-100（越高越重）：来自 TechDebtReportData.debtIndex */
  debtIndex: number;
  /** 债务动作总数：来自 TechDebtReportData.actionList.length */
  issueCount: number;
  lastRunAt: string;
}

/** 重构域聚合数据 */
export interface DashboardRefactorState {
  /** 代码异味总数：来自 RefactorReport.totalSmells */
  totalSmells: number;
  /** 按严重度分布（error/warning/info）：来自 RefactorReport.bySeverity */
  bySeverity: { error: number; warning: number; info: number };
  /**
   * 本次实际扫描的文件数：来自 RefactorReport.scannedFiles（P1-9）。
   * 0 = 该项目一个文件都没进检测器（如纯 JS 项目，重构引擎只收 .ts/.tsx）
   * → 评分侧按 not-run 处理，不得把"没看"当成"干净"给满分。
   * 旧版 dashboard-state 无此字段（undefined）→ 评分侧保持 scored，不误判历史数据。
   */
  scannedFiles?: number;
  lastRunAt: string;
}

/** 性能域聚合数据 */
export interface DashboardPerformanceState {
  /** 性能问题总数：来自 PerformanceReportData.summary.total */
  total: number;
  /** 按严重度分布（critical/high/medium/low/info） */
  bySeverity: { critical: number; high: number; medium: number; low: number; info: number };
  lastRunAt: string;
}

/** 垃圾清理域聚合数据（十域评分章程 #5） */
export interface DashboardGarbageState {
  /** 垃圾条目总数：来自 GarbageScanReport.summary.total */
  total: number;
  /** 类型 → 条目数：来自 GarbageScanReport.summary.byType（清理后按清理条目递减） */
  byType: Record<string, number>;
  lastRunAt: string;
}

/** dashboard-state.json 完整形状 */
export interface DashboardState {
  deps?: DashboardDepsState;
  secrets?: DashboardSecretsState;
  techdebt?: DashboardTechDebtState;
  refactor?: DashboardRefactorState;
  performance?: DashboardPerformanceState;
  garbage?: DashboardGarbageState;
}

// ─── 文件路径 ─────────────────────────────────────────────────────

function statePath(projectPath: string): string {
  return join(projectPath, '.zhshield', 'dashboard-state.json');
}

// ─── 串行化写入队列 ──────────────────────────────────────────────

let writeQueue: Promise<unknown> = Promise.resolve();

// ─── 读取 ────────────────────────────────────────────────────────

/** 读取 dashboard-state.json；文件不存在或解析失败时返回空对象 */
export async function readDashboardState(projectPath: string): Promise<DashboardState> {
  try {
    const raw = await readFile(statePath(projectPath), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<DashboardState>;
    return {
      ...(parsed.deps ? { deps: parsed.deps } : {}),
      ...(parsed.secrets ? { secrets: parsed.secrets } : {}),
      ...(parsed.techdebt ? { techdebt: parsed.techdebt } : {}),
      ...(parsed.refactor ? { refactor: parsed.refactor } : {}),
      ...(parsed.performance ? { performance: parsed.performance } : {}),
      ...(parsed.garbage ? { garbage: parsed.garbage } : {}),
    };
  } catch {
    return {};
  }
}

// ─── 更新（原子读-改-写，在写入队列中串行化） ────────────────────

/**
 * 合并 patch 到当前 dashboard-state.json 并持久化。
 * 读-改-写在 writeQueue 中串行执行，避免并发扫描交错覆盖。
 * 写入失败静默降级（catch 打 warn），不阻塞调用方主流程。
 */
export async function updateDashboardState(
  projectPath: string,
  patch: Partial<DashboardState>,
): Promise<void> {
  try {
    writeQueue = writeQueue.then(async () => {
      const current = await readDashboardState(projectPath);
      const next: DashboardState = { ...current };
      // 逐域合并：仅 patch 中存在的域覆盖，不覆盖其他域
      if (patch.deps !== undefined) next.deps = patch.deps;
      if (patch.secrets !== undefined) next.secrets = patch.secrets;
      if (patch.techdebt !== undefined) next.techdebt = patch.techdebt;
      if (patch.refactor !== undefined) next.refactor = patch.refactor;
      if (patch.performance !== undefined) next.performance = patch.performance;
      if (patch.garbage !== undefined) next.garbage = patch.garbage;
      await mkdir(join(projectPath, '.zhshield'), { recursive: true });
      await writeFile(statePath(projectPath), `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
    });
    await writeQueue;
  } catch (err) {
    console.warn(
      '[dashboard-state] 状态落盘失败（静默降级）:',
      err instanceof Error ? err.message : String(err),
    );
  }
}
