import type { HealthScoreData } from '../types/electron';
import { getScoreColor, getScoreLabel } from './reports-logic';
import { PageGlyph } from '../components/business/page-glyph';
import { PrimaryButton } from '../components/ui/PrimaryButton';
import { ResultCard } from '../components/ui/ResultCard';
import { useT } from '../i18n';
import type { ModuleScoreView } from './module-scores-logic';

function DocLayer({
  x,
  y,
  fill,
  stroke,
  strokeWidth,
}: {
  x: string;
  y: string;
  fill: string;
  stroke: string;
  strokeWidth: string;
}) {
  return (
    <rect x={x} y={y} width="70" height="50" rx="4" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
  );
}

function DocDetails() {
  return (
    <>
      <line
        x1="62"
        y1="55"
        x2="105"
        y2="55"
        stroke="rgb(var(--zh-info))"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <line
        x1="62"
        y1="62"
        x2="95"
        y2="62"
        stroke="rgb(var(--zh-info) / 0.25)"
        strokeWidth="1"
        strokeLinecap="round"
      />
      <line
        x1="62"
        y1="69"
        x2="100"
        y2="69"
        stroke="rgb(var(--zh-info) / 0.2)"
        strokeWidth="1"
        strokeLinecap="round"
      />
      <rect
        x="62"
        y="73"
        width="18"
        height="3"
        rx="1"
        fill="none"
        stroke="rgb(var(--zh-brand))"
        strokeWidth="1.2"
      />
      <rect
        x="62"
        y="79"
        width="12"
        height="3"
        rx="1"
        fill="none"
        stroke="rgb(var(--zh-info))"
        strokeWidth="1.2"
      />
    </>
  );
}

/** 文档堆叠 SVG（线性风格） */
export function StackedDocs() {
  return (
    <svg width="150" height="150" viewBox="0 0 150 150" fill="none">
      <circle cx="75" cy="75" r="65" fill="rgb(var(--zh-info) / 0.05)" />
      {/* 底层文档 */}
      <DocLayer
        x="35"
        y="55"
        fill="rgb(var(--zh-info) / 0.06)"
        stroke="rgb(var(--zh-info) / 0.25)"
        strokeWidth="1.2"
      />
      {/* 中层文档 */}
      <DocLayer
        x="42"
        y="48"
        fill="rgb(var(--zh-info) / 0.08)"
        stroke="rgb(var(--zh-info) / 0.2)"
        strokeWidth="1.2"
      />
      {/* 顶层文档 */}
      <DocLayer
        x="49"
        y="41"
        fill="none"
        stroke="rgb(var(--zh-info))"
        strokeWidth="1.8"
      />
      {/* 文档上的线 */}
      <DocDetails />
    </svg>
  );
}

export function ReportsHeader({
  count,
  latest,
  onNewReport,
}: {
  count: number;
  latest: HealthScoreData;
  onNewReport: () => void;
}) {
  const t = useT();
  return (
    <div className="flex items-center gap-4 mb-6">
      <PageGlyph bg="info" stroke="info">
        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
        <polyline points="14 2 14 8 20 8" />
      </PageGlyph>
      <div>
        <h1 className="text-2xl font-bold text-zh-ink mb-1">{t('page.reports.title')}</h1>
        <p className="text-sm text-zh-muted">
          {t('page.reports.header.count', {
            count,
            date: new Date(latest.timestamp).toLocaleDateString(),
          })}
        </p>
      </div>
      <PrimaryButton className="ml-auto" onClick={onNewReport}>
        {t('page.reports.header.generate')}
      </PrimaryButton>
    </div>
  );
}

/**
 * 模块级评分卡：monorepo 各子模块独立评分，按模块渲染（无子模块时不渲染）。
 *
 * 与「评分总览」一行十一格长相接近，必须自带标题区分：总览是**整机十域**各一个分，
 * 这里是**每个子包**各一个分（同一套十域按模块重跑）。没有标题时两块并排
 * 会被当成同一批数据的两种排法。
 */
export function ModuleScoreCards({ modules }: { modules: ModuleScoreView[] }) {
  const t = useT();
  if (modules.length === 0) return null;
  return (
    <section className="mb-6" data-testid="module-score-cards">
      <h2 className="text-sm font-semibold text-zh-ink-2 mb-2">
        {t('page.reports.moduleScore.title')}
      </h2>
      <div className="flex gap-4 flex-wrap">
        {modules.map((m) => {
          const color = m.score == null ? 'rgb(var(--zh-muted))' : getScoreColor(m.score);
          const label = m.score == null ? '—' : getScoreLabel(m.score);
          return (
            <ResultCard key={m.path} variant="stats" className="min-w-[150px]">
              <div className="text-xs text-zh-muted mb-1 truncate" title={m.path}>
                {m.name}
              </div>
              <div className="flex items-center gap-2">
                <div
                  className="w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold text-white shrink-0"
                  style={{ background: color }}
                >
                  {m.score ?? '–'}
                </div>
                <div>
                  <div className="text-xs font-semibold" style={{ color }}>
                    {label}
                  </div>
                  <div className="text-[10px] text-zh-muted">{m.type}</div>
                </div>
              </div>
            </ResultCard>
          );
        })}
      </div>
    </section>
  );
}
