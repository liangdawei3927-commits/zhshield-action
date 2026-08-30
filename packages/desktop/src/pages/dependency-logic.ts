import { useCallback, useState } from 'react';
import { runDeps } from '../services/engineApi';
import type { DependencyReportData } from '../types/electron';

/**
 * 许可证类别配置：permissive 绿 / weak-copyleft 黄 / strong-copyleft 红 / unknown 灰
 * （与 @zh/dependency 引擎 LicenseCategory 对齐）
 */
export const LICENSE_CATEGORY_CONFIG: Record<string, { color: string; bg: string; labelKey: string; riskKey: string }> = {
  permissive: { color: 'rgb(var(--zh-success-700))', bg: 'rgb(var(--zh-success) / 0.08)', labelKey: 'page.deps.license.permissive', riskKey: 'page.deps.license.risk.low' },
  'weak-copyleft': { color: 'rgb(var(--zh-warning))', bg: 'rgb(var(--zh-warning) / 0.12)', labelKey: 'page.deps.license.weakCopyleft', riskKey: 'page.deps.license.risk.medium' },
  'strong-copyleft': { color: 'rgb(var(--zh-danger))', bg: 'rgb(var(--zh-danger) / 0.1)', labelKey: 'page.deps.license.strongCopyleft', riskKey: 'page.deps.license.risk.high' },
  unknown: { color: 'rgb(var(--zh-muted))', bg: 'rgb(var(--zh-muted) / 0.08)', labelKey: 'page.deps.license.unknown', riskKey: 'page.deps.license.risk.unknown' },
};

/** 许可证类别展示顺序（矩阵四宫格） */
export const LICENSE_CATEGORY_ORDER: string[] = ['permissive', 'weak-copyleft', 'strong-copyleft', 'unknown'];

/** 信任状态配置：verified 绿 / suspicious 橙 / compromised 红 / unknown 灰 */
export const TRUST_STATUS_CONFIG: Record<string, { color: string; bg: string; labelKey: string }> = {
  verified: { color: 'rgb(var(--zh-success-700))', bg: 'rgb(var(--zh-success) / 0.08)', labelKey: 'page.deps.trust.verified' },
  suspicious: { color: 'rgb(var(--zh-warning))', bg: 'rgb(var(--zh-warning) / 0.12)', labelKey: 'page.deps.trust.suspicious' },
  compromised: { color: 'rgb(var(--zh-danger))', bg: 'rgb(var(--zh-danger) / 0.1)', labelKey: 'page.deps.trust.compromised' },
  unknown: { color: 'rgb(var(--zh-muted))', bg: 'rgb(var(--zh-muted) / 0.08)', labelKey: 'page.deps.trust.unknown' },
};

/** 信任状态展示顺序（统计四宫格） */
export const TRUST_STATUS_ORDER: string[] = ['verified', 'suspicious', 'compromised', 'unknown'];

/** 锁文件三态配置：勾选（通过）/ 叉号（未通过）/ 灰态（无法评估，锁文件缺失时）；naKey 逐行独立 */
export const LOCKFILE_CHECKS: Array<{
  key: 'present' | 'consistent' | 'integrityVerified';
  okKey: string;
  failKey: string;
  naKey: string;
}> = [
  { key: 'present', okKey: 'page.deps.lockfile.present', failKey: 'page.deps.lockfile.notPresent', naKey: 'page.deps.lockfile.notEvaluable' },
  { key: 'consistent', okKey: 'page.deps.lockfile.consistent', failKey: 'page.deps.lockfile.notConsistent', naKey: 'page.deps.lockfile.notEvaluableConsistency' },
  { key: 'integrityVerified', okKey: 'page.deps.lockfile.integrityVerified', failKey: 'page.deps.lockfile.integrityFailed', naKey: 'page.deps.lockfile.notEvaluableIntegrity' },
];

/** 锁文件检查三态：ok 通过 / fail 校验失败 / na 无法评估 */
export type LockfileCheckState = 'ok' | 'fail' | 'na';

/**
 * 锁文件勾选状态判定：present 恒可判定；consistent / integrityVerified
 * 在锁文件缺失（present=false）时不可评估（na），不与其他失败混淆。
 */
export function resolveLockfileCheck(
  lockfile: Pick<DependencyReportData['lockfile'], 'present' | 'consistent' | 'integrityVerified'>,
  key: 'present' | 'consistent' | 'integrityVerified',
): LockfileCheckState {
  if (key === 'present') return lockfile.present ? 'ok' : 'fail';
  if (!lockfile.present) return 'na';
  return lockfile[key] ? 'ok' : 'fail';
}

/** 风险等级徽章配置（投毒检测 / 升级评估共用）：high 红 / medium 橙 / low 灰 */
export const RISK_BADGE_CONFIG: Record<string, { color: string; bg: string; labelKey: string }> = {
  high: { color: 'rgb(var(--zh-danger))', bg: 'rgb(var(--zh-danger) / 0.1)', labelKey: 'page.deps.risk.high' },
  medium: { color: 'rgb(var(--zh-warning))', bg: 'rgb(var(--zh-warning) / 0.12)', labelKey: 'page.deps.risk.medium' },
  low: { color: 'rgb(var(--zh-muted))', bg: 'rgb(var(--zh-muted) / 0.08)', labelKey: 'page.deps.risk.low' },
};

/** 环境一致性严重度配置：error 红 / warning 橙 / info 灰 */
export const ENV_SEVERITY_CONFIG: Record<string, { color: string; bg: string; labelKey: string }> = {
  error: { color: 'rgb(var(--zh-danger))', bg: 'rgb(var(--zh-danger) / 0.1)', labelKey: 'page.deps.env.severity.error' },
  warning: { color: 'rgb(var(--zh-warning))', bg: 'rgb(var(--zh-warning) / 0.12)', labelKey: 'page.deps.env.severity.warning' },
  info: { color: 'rgb(var(--zh-muted))', bg: 'rgb(var(--zh-muted) / 0.08)', labelKey: 'page.deps.env.severity.info' },
};

/** 依赖管家运行：loading 为本地状态（engine:runDeps 直连主进程，不经任务中心） */
function useDependencyRun(projectPath: string): {
  loading: boolean;
  report: DependencyReportData | null;
  handleScan: () => Promise<void>;
} {
  const [report, setReport] = useState<DependencyReportData | null>(null);
  const [loading, setLoading] = useState(false);

  const handleScan = useCallback(async () => {
    setLoading(true);
    try {
      const result = await runDeps(projectPath);
      setReport(result);
    } catch {
      setReport(null);
    } finally {
      setLoading(false);
    }
  }, [projectPath]);

  return { loading, report, handleScan };
}

export function useDependencyPage(projectPath: string) {
  return useDependencyRun(projectPath);
}
