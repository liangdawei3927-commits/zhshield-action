import type { SecurityScanReportData } from '../types/electron';
import { useT } from '../i18n';
import {
  SEVERITY_CONFIG,
  MALWARE_TYPE_LABEL,
  SECURITY_PLANNED_DESCRIPTIONS,
  type SecurityIssue,
} from './security-logic';
import { buildPlannedCapabilities } from '../components/business/capability-features';
import { ResultCard } from '../components/ui/ResultCard';
import { CopyToAiButton } from '../components/ui/CopyToAiButton';
import { CopyAllToAiButton } from '../components/ui/CopyAllToAiButton';
import { SeverityBadge } from '../components/ui/SeverityBadge';

function FindingCard({
  finding,
  onCopyToAi,
}: {
  finding: SecurityScanReportData['findings'][number];
  onCopyToAi: (issue: SecurityIssue) => void;
}) {
  const t = useT();
  const cfg = SEVERITY_CONFIG[finding.severity] ?? SEVERITY_CONFIG.low;
  return (
    <ResultCard>
      <div className="flex items-center gap-3">
        <SeverityBadge bg={cfg.bg} color={cfg.color} label={t(cfg.labelKey)} />
        <span className="text-sm font-medium text-zh-ink-2">{finding.title}</span>
        <CopyToAiButton className="ml-auto" onClick={() => onCopyToAi(finding)} />
      </div>
      <div className="mt-2 text-xs text-zh-muted">
        {finding.file}
        {finding.line != null ? `:${finding.line}` : ''}
      </div>
      <div className="mt-1 text-xs text-zh-muted">{finding.description}</div>
      {finding.recommendation && (
        <div className="mt-1 text-xs text-info-500">
          {t('page.security.recommendation', { recommendation: finding.recommendation })}
        </div>
      )}
    </ResultCard>
  );
}

function MalwareCard({
  item,
  onCopyToAi,
}: {
  item: SecurityScanReportData['malware'][number];
  onCopyToAi: (item: SecurityScanReportData['malware'][number]) => void;
}) {
  const t = useT();
  const cfg = SEVERITY_CONFIG[item.severity] ?? SEVERITY_CONFIG.low;
  return (
    <ResultCard>
      <div className="flex items-center gap-3">
        <SeverityBadge bg={cfg.bg} color={cfg.color} label={t(cfg.labelKey)} />
        <span className="px-2 py-0.5 rounded text-xs font-medium bg-zh-panel text-zh-ink-2">
          {t(MALWARE_TYPE_LABEL[item.type] ?? item.type)}
        </span>
        <span className="text-sm font-medium text-zh-ink-2">{item.title}</span>
        <CopyToAiButton className="ml-auto" onClick={() => onCopyToAi(item)} />
      </div>
      <div className="mt-2 text-xs text-zh-muted">
        {item.file}:{item.line}
      </div>
      <div className="mt-1 text-xs text-zh-muted">{item.description}</div>
      {item.evidence && (
        <div className="mt-2 px-3 py-1.5 rounded bg-danger-50 text-[11px] font-mono text-danger-700 break-all">
          {item.evidence}
        </div>
      )}
    </ResultCard>
  );
}

export function FindingsPanel({
  findings,
  onCopyToAi,
  onCopyAll,
}: {
  findings: SecurityScanReportData['findings'];
  onCopyToAi: (issue: SecurityIssue) => void;
  onCopyAll: (issues: SecurityIssue[]) => void;
}) {
  const t = useT();
  return (
    <div>
      {findings.length > 0 && (
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs text-zh-muted">
            {t('page.security.copyAllPrompt', { count: findings.length })}
          </span>
          <CopyAllToAiButton onClick={() => onCopyAll(findings)} />
        </div>
      )}
      <div className="space-y-3">
        {findings.map((finding) => (
          <FindingCard key={finding.id} finding={finding} onCopyToAi={onCopyToAi} />
        ))}
        {findings.length === 0 && (
          <div className="rounded-xl flex flex-col items-center justify-center py-16 gap-2 bg-zh-panel border border-dashed border-zh-line">
            <span className="text-2xl">✅</span>
            <span className="text-sm font-medium text-success-700">
              {t('page.security.noFindings')}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

export function MalwarePanel({
  items,
  onCopyToAi,
  onCopyAll,
}: {
  items: SecurityScanReportData['malware'];
  onCopyToAi: (item: SecurityScanReportData['malware'][number]) => void;
  onCopyAll: (items: SecurityScanReportData['malware']) => void;
}) {
  const t = useT();
  return (
    <div>
      {items.length > 0 && (
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs text-zh-muted">
            {t('page.security.copyAllPrompt', { count: items.length })}
          </span>
          <CopyAllToAiButton onClick={() => onCopyAll(items)} />
        </div>
      )}
      <div className="space-y-3">
        {items.map((item) => (
          <MalwareCard key={item.id} item={item} onCopyToAi={onCopyToAi} />
        ))}
        {items.length === 0 && (
          <div className="rounded-xl flex flex-col items-center justify-center py-16 gap-2 bg-zh-panel border border-dashed border-zh-line">
            <span className="text-2xl">🛡️</span>
            <span className="text-sm font-medium text-success-700">
              {t('page.security.noMalware')}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 报告页的「本页不覆盖的能力」：读结论时也要看得见边界。
 *
 * 空态那行灰字只在「没扫过」时出现；用户在报告页读结论时更容易误以为
 * “这页查得全”。同一条能力边界（规划中 / 已移交）始终可发现，但只用两行
 * 小字，不与扫描结果抢注意力。清单由能力注册表驱动，不手写第二份。
 */
export function SecurityNotCovered() {
  const planned = buildPlannedCapabilities('security', SECURITY_PLANNED_DESCRIPTIONS);
  if (planned.length === 0) return null;
  return (
    <section className="mt-5" data-testid="security-not-covered">
      <p className="text-xs font-medium text-zh-muted">本页不覆盖的能力</p>
      <ul className="mt-1.5 flex flex-col gap-1">
        {planned.map((item) => (
          <li key={item.id} className="flex items-start gap-2 text-[11px] text-zh-muted">
            <span className="shrink-0 rounded bg-zh-panel px-1.5 py-0.5">
              {item.status === 'deprecated' ? '已移交' : '规划中'}
            </span>
            <span className="shrink-0 font-medium text-zh-ink-2/70">{item.title}</span>
            <span className="flex-1 min-w-0 text-zh-muted/80">{item.desc}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
