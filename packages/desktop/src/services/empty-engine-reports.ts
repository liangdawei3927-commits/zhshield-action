/**
 * 引擎空报告构造器（主进程与渲染进程共用）
 *
 * 主进程（electron/ipc/engines.ts）在引擎执行失败时、渲染进程
 * （src/services/engineApi.ts）在引擎通道不可用（window.electronAPI.engine
 * 缺失 / mock 模式）时，此前各内联一份逐字相同的空报告字面量。此处单源化，
 * 两侧失败回退的数据形状与时间戳语义保持不变。
 */
import type { DependencyReportData, SecurityScanReportData } from '../types/electron';

/** 安全扫描空报告：零发现 + 满分 100（无可用引擎/执行失败时的保守回退） */
export function emptySecurityScanReportData(): SecurityScanReportData {
  return {
    summary: {
      total: 0,
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      malwareTotal: 0,
    },
    findings: [],
    malware: [],
    securityScore: 100,
    metadata: { duration: 0, timestamp: new Date().toISOString() },
  };
}

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
