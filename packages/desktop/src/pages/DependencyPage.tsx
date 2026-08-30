import { useCallback } from 'react';
import { useDependencyPage } from './dependency-logic';
import {
  DependencyEmptyState,
  DependencyHeader,
  DependencyOverviewCard,
  DependencyLockfileCard,
  DependencyTrustCard,
  DependencyLicenseCard,
  DependencyTyposquatCard,
  DependencyLockfileVerificationCard,
  DependencyUpgradeCard,
  DependencyEnvCard,
  DependencyOutdatedCard,
} from './dependency-parts';
import { useToast } from '../components/ui/Toast';
import { useT } from '../i18n';
import { exportHtmlReport } from '../utils/htmlExport';
import type { HtmlReportData } from '@zh/reporter';
import type { DependencyReportData } from '../types/electron';

interface DependencyPageProps {
  projectPath: string;
}

function buildOverviewSection(report: DependencyReportData): HtmlReportData['sections'][number] {
  return {
    title: 'Overview',
    items: [
      { status: 'pass', message: `Direct dependencies: ${report.direct}` },
      { status: 'pass', message: `Transitive dependencies: ${report.transitive}` },
      { status: 'pass', message: `Total: ${report.total}, Edges: ${report.edgeCount}` },
    ],
  };
}

function buildLockfileSection(report: DependencyReportData): HtmlReportData['sections'][number] | null {
  if (report.lockfileVerification.status === 'missing') return null;
  const lockfileItems = [
    {
      status: report.lockfileVerification.status === 'clean' ? 'pass' as const : 'warn' as const,
      message: `Lockfile status: ${report.lockfileVerification.status}`,
    },
  ];
  for (const diff of report.lockfileVerification.diffs) {
    lockfileItems.push({
      status: 'warn',
      message: `${diff.name}: declared ${diff.declaredVersion}, locked ${diff.lockedVersion}`,
    });
  }
  return { title: 'Lockfile Verification', items: lockfileItems };
}

function buildTyposquatSection(report: DependencyReportData): HtmlReportData['sections'][number] | null {
  if (report.typosquatFindings.length === 0) return null;
  return {
    title: 'Typosquat Findings',
    items: report.typosquatFindings.map((f) => ({
      status: f.risk === 'high' ? 'fail' as const : f.risk === 'medium' ? 'warn' as const : 'pass' as const,
      message: `${f.nodeId}: ${f.evidence.join('; ')}`,
      severity: f.risk,
    })),
  };
}

function buildUpgradeSection(report: DependencyReportData): HtmlReportData['sections'][number] | null {
  if (report.upgradeAssessments.length === 0) return null;
  return {
    title: 'Upgrade Assessments',
    items: report.upgradeAssessments.map((a) => ({
      status: a.candidates.some((c) => c.risk === 'high') ? 'fail' as const : 'warn' as const,
      message: `${a.nodeId}: ${a.candidates.map((c) => c.targetVersion).join(', ')}`,
    })),
  };
}

function buildEnvSection(report: DependencyReportData): HtmlReportData['sections'][number] | null {
  if (report.envEntries.length === 0) return null;
  return {
    title: 'Environment Consistency',
    items: report.envEntries.map((e) => ({
      status: e.severity === 'error' ? 'fail' as const : e.severity === 'warning' ? 'warn' as const : 'pass' as const,
      message: `${e.name}: expected ${e.expected}, actual ${e.actual}`,
      severity: e.severity === 'error' ? 'high' : e.severity === 'warning' ? 'medium' : 'low',
    })),
  };
}

function buildOptionalSections(report: DependencyReportData): HtmlReportData['sections'] {
  const sections: HtmlReportData['sections'] = [];
  const lockfile = buildLockfileSection(report);
  if (lockfile) sections.push(lockfile);
  const typosquat = buildTyposquatSection(report);
  if (typosquat) sections.push(typosquat);
  const upgrade = buildUpgradeSection(report);
  if (upgrade) sections.push(upgrade);
  const env = buildEnvSection(report);
  if (env) sections.push(env);
  return sections;
}

function dependencyReportToHtmlData(report: DependencyReportData, projectPath: string): HtmlReportData {
  const sections: HtmlReportData['sections'] = [buildOverviewSection(report), ...buildOptionalSections(report)];
  const totalIssues = sections.reduce<number>((acc, s) => acc + s.items.length, 0);
  const failures = sections.reduce<number>((acc, s) => acc + s.items.filter((i) => i.status === 'fail').length, 0);
  const warnings = sections.reduce<number>((acc, s) => acc + s.items.filter((i) => i.status === 'warn').length, 0);

  return {
    timestamp: report.generatedAt,
    projectName: projectPath.split('/').pop() ?? projectPath,
    summary: {
      total: totalIssues,
      passed: totalIssues - failures - warnings,
      warnings,
      failures,
    },
    sections,
  };
}

async function exportDependencyReport(
  report: DependencyReportData,
  projectPath: string,
  toast: (msg: string, variant?: 'success' | 'error' | 'warning' | 'info') => void,
  t: (key: string, opts?: { defaultValue?: string }) => string,
): Promise<void> {
  try {
    const ok = await exportHtmlReport(dependencyReportToHtmlData(report, projectPath), 'dependency-report.html');
    if (ok) toast(t('page.deps.exportSuccess', { defaultValue: 'Report exported' }), 'success');
  } catch {
    toast(t('page.deps.exportFailed', { defaultValue: 'Export failed' }), 'error');
  }
}

function DependencyReportView({
  report,
  loading,
  onRescan,
  onExport,
  t,
}: {
  report: DependencyReportData;
  loading: boolean;
  onRescan: () => void;
  onExport: () => void;
  t: (key: string, opts?: { defaultValue?: string }) => string;
}) {
  return (
    <div className="h-full w-full bg-zh-bg overflow-auto">
      <div className="w-full px-8 py-10">
        <DependencyHeader report={report} loading={loading} onRescan={onRescan} />
        <div className="flex justify-end mb-4">
          <button
            type="button"
            onClick={onExport}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border border-zh-line bg-white hover:bg-zh-panel text-zh-ink-2 cursor-pointer transition-colors"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            {t('page.deps.exportReport', { defaultValue: 'Export Report' })}
          </button>
        </div>
        <DependencyOverviewCard report={report} />
        <div className="grid grid-cols-2 gap-6 mb-6">
          <DependencyLockfileCard lockfile={report.lockfile} />
          <DependencyTrustCard trustCounts={report.trustCounts} />
        </div>
        <DependencyLicenseCard matrix={report.licenseMatrix} />
        <div className="grid grid-cols-2 gap-6 my-6">
          <DependencyTyposquatCard report={report} />
          <DependencyLockfileVerificationCard report={report} />
        </div>
        <div className="grid grid-cols-2 gap-6">
          <DependencyUpgradeCard report={report} />
          <DependencyEnvCard report={report} />
        </div>
        <div className="mt-6">
          <DependencyOutdatedCard report={report} />
        </div>
      </div>
    </div>
  );
}

export function DependencyPage({ projectPath }: DependencyPageProps) {
  const { loading, report, handleScan } = useDependencyPage(projectPath);
  const { toast } = useToast();
  const t = useT();

  const handleExport = useCallback(async () => {
    if (report == null) return;
    await exportDependencyReport(report, projectPath, toast, t);
  }, [report, projectPath, toast, t]);

  if (report) {
    return <DependencyReportView report={report} loading={loading} onRescan={handleScan} onExport={handleExport} t={t} />;
  }

  return <DependencyEmptyState loading={loading} onScan={handleScan} />;
}
