/**
 * CVE 检测卡片（从 dependency-parts.tsx 下沉到独立子模块）
 */
import type { DependencyReportData } from '../types/electron';
import { useT } from '../i18n';
import { ResultCard } from '../components/ui/ResultCard';
import { SectionTitle } from '../components/ui/SectionTitle';
import { SectionIcon } from '../components/ui/Icons';
import { ConfigCountTile } from './dependency-parts-license';

/**
 * 严重度 → 计数卡配色。
 *
 * 抽成查表而不是在 JSX 里写嵌套三元：那两处三元一旦被 Prettier 展开成多行，
 * 会把整个组件撑过 long-method 阈值（语义没变却新增一条坏味道）。
 * 而它本质上就是三档映射，查表本就比嵌套三元更贴切。
 */
const SEVERITY_TILE_STYLE = {
  critical: { bg: 'bg-danger-50', color: 'text-danger-600' },
  high: { bg: 'bg-warning-50', color: 'text-warning-600' },
  medium: { bg: 'bg-zh-card', color: 'text-zh-ink' },
} as const;

/**
 * P1-8：CVE 检测卡片。核心契约——「不可用」必须显形：
 * status='unavailable' 显示「CVE 未检测」+ 原因，绝不静默呈现 0 漏洞的安全假象。
 * 旧数据无 cve 字段（undefined）同样按未检测对待。
 */
export function DependencyCveCard({ report }: { report: DependencyReportData }) {
  const t = useT();
  const cve = report.cve;
  const unavailable = !cve || cve.status === 'unavailable';
  return (
    <ResultCard variant="score">
      <SectionTitle
        icon={
          <SectionIcon>
            <path d="M12 2L2 7l10 5 10-5-10-5z" />
            <path d="M2 17l10 5 10-5" />
            <path d="M2 12l10 5 10-5" />
          </SectionIcon>
        }
        label={t('page.deps.cve.title')}
      />
      {unavailable ? (
        <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-warning-50 border border-warning-100">
          <div>
            <div className="text-sm font-medium text-warning-700">
              {t('page.deps.cve.unavailable')}
            </div>
            <div className="text-xs text-warning-500 mt-0.5">
              {cve?.reason ?? t('page.deps.cve.dataUnavailable')}
            </div>
          </div>
        </div>
      ) : cve.findings.length === 0 ? (
        <p className="text-sm text-zh-muted">{t('page.deps.cve.none')}</p>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3 mb-3">
            {(['critical', 'high', 'medium'] as const).map((sev) => {
              const count = cve.findings.filter((f) => f.severity === sev).length;
              const tile = SEVERITY_TILE_STYLE[sev];
              return (
                <ConfigCountTile
                  key={sev}
                  bg={tile.bg}
                  color={tile.color}
                  count={count}
                  label={t(`severity.${sev}`)}
                />
              );
            })}
          </div>
          <div className="space-y-2">
            {cve.findings.map((f) => (
              <div
                key={`${f.name}@${f.version}:${f.ids}`}
                className="flex items-start justify-between gap-3 px-3 py-2 rounded-lg bg-zh-card text-sm"
              >
                <div className="min-w-0">
                  <div className="font-mono text-xs text-zh-ink truncate">
                    {f.name}@{f.version} · {f.ids}
                  </div>
                  {f.summary && <div className="text-xs text-zh-muted mt-0.5">{f.summary}</div>}
                </div>
                <span
                  className={`shrink-0 text-xs px-2 py-0.5 rounded-full ${
                    f.severity === 'critical'
                      ? 'bg-danger-50 text-danger-600'
                      : f.severity === 'high'
                        ? 'bg-warning-50 text-warning-600'
                        : 'bg-zh-muted/10 text-zh-muted'
                  }`}
                >
                  {t(`severity.${f.severity}`)}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </ResultCard>
  );
}
