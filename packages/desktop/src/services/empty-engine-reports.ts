/**
 * 引擎空报告构造器（主进程与渲染进程共用）
 *
 * 依赖报告（DependencyReportData）保留唯一空报告构造器——它有带内 error 横幅，
 * 失败以数据形状表达。安全/性能/垃圾清理已全部改为显式失败（throw），
 * 不再提供「零发现 + 满分」的空报告：那会把「没查成」伪装成「查过且干净」。
 */
import type { DependencyReportData } from '../types/electron';

/** 依赖报告空报告：零依赖 + 无 lockfile，`error` 携带失败原因（不 throw） */
export function emptyDependencyReportData(error: string): DependencyReportData {
  return {
    schemaVersion: 0,
    targetId: '',
    ecosystem: 'mixed',
    direct: 0,
    transitive: 0,
    total: 0,
    edgeCount: 0,
    lockfile: { present: false, consistent: false, integrityVerified: false },
    trustCounts: {},
    licenseMatrix: { total: 0, byCategory: {}, entries: [] },
    typosquatFindings: [],
    lockfileVerification: { status: 'missing', diffs: [], integrityFailures: [] },
    upgradeAssessments: [],
    envEntries: [],
    generatedAt: new Date().toISOString(),
    error,
  };
}
