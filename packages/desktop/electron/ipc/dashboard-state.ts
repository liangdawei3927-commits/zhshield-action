/**
 * 仪表盘聚合数据层（ipc/dashboard-state.ts）
 *
 * 维护 .zhshield/dashboard-state.json：deps / secrets / techdebt / refactor / performance
 * 五域的最新统计摘要 + lastRunAt，供 getDashboardOverview 一次读取六卡数据。
 * quality / gate 卡读 latest.json（各域覆盖写，generatedAt 作为 lastRunAt）；
 * sentinel 卡读运行时 SentinelRuntime（P1a-3 豁免，不落盘）。
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

/** dashboard-state.json 完整形状 */
export interface DashboardState {
  deps?: DashboardDepsState;
  secrets?: DashboardSecretsState;
  techdebt?: DashboardTechDebtState;
  refactor?: DashboardRefactorState;
  performance?: DashboardPerformanceState;
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
