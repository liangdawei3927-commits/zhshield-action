import type { HealthScoreData } from '../types/electron';
import { getScoreColor, getScoreLabel } from './reports-logic';
import { Bounce } from '../components/ui/Bounce';
import { PrimaryButton } from '../components/ui/PrimaryButton';
import { ResultCard } from '../components/ui/ResultCard';
import { useT } from '../i18n';
import type { ModuleScoreView } from './module-scores-logic';

function SparklineChart({ data }: { data: HealthScoreData[] }) {
  if (data.length < 2) return null;
  const values = data.map((d) => d.score);
  const max = Math.max(...values, 60);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const w = 100;
  const h = 32;
  const stepX = w / (values.length - 1);
  const points = values.map((v, i) => `${i * stepX},${h - ((v - min) / range) * (h - 4) - 2}`).join(' ');
  const latest = values.at(-1)!;
  const prev = values.length > 1 ? values[values.length - 2] : latest;
  const color = getScoreColor(latest);

  return (
    <div className="flex items-center gap-3">
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="shrink-0">
        <polyline points={points} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
        <circle cx={(values.length - 1) * stepX} cy={h - ((latest - min) / range) * (h - 4) - 2} r="2.5" fill={color} />
      </svg>
      <div className="flex flex-col">
        <span className="text-xs font-bold" style={{ color }}>{latest}</span>
        <span className="text-[10px] text-zh-muted">
          {latest > prev ? '↑' : latest < prev ? '↓' : '→'} {Math.abs(latest - prev)}
        </span>
      </div>
    </div>
  );
}

/** 文档堆叠 SVG（线性风格） */
export function StackedDocs() {
  return (
    <svg width="150" height="150" viewBox="0 0 150 150" fill="none">
      <circle cx="75" cy="75" r="65" fill="rgb(var(--zh-info) / 0.05)" />
      {/* 底层文档 */}
      <rect x="35" y="55" width="70" height="50" rx="4" fill="rgb(var(--zh-info) / 0.06)" stroke="rgb(var(--zh-info) / 0.25)" strokeWidth="1.2" />
      {/* 中层文档 */}
      <rect x="42" y="48" width="70" height="50" rx="4" fill="rgb(var(--zh-info) / 0.08)" stroke="rgb(var(--zh-info) / 0.2)" strokeWidth="1.2" />
      {/* 顶层文档 */}
      <rect x="49" y="41" width="70" height="50" rx="4" fill="none" stroke="rgb(var(--zh-info))" strokeWidth="1.8" />
      {/* 文档上的线 */}
      <line x1="62" y1="55" x2="105" y2="55" stroke="rgb(var(--zh-info))" strokeWidth="1.2" strokeLinecap="round" />
      <line x1="62" y1="62" x2="95" y2="62" stroke="rgb(var(--zh-info) / 0.25)" strokeWidth="1" strokeLinecap="round" />
      <line x1="62" y1="69" x2="100" y2="69" stroke="rgb(var(--zh-info) / 0.2)" strokeWidth="1" strokeLinecap="round" />
      {/* 图表小元素 */}
      <rect x="62" y="73" width="18" height="3" rx="1" fill="none" stroke="rgb(var(--zh-brand))" strokeWidth="1.2" />
      <rect x="62" y="79" width="12" height="3" rx="1" fill="none" stroke="rgb(var(--zh-info))" strokeWidth="1.2" />
    </svg>
  );
}

export function ReportsHeader({ count, latest, onNewReport }: { count: number; latest: HealthScoreData; onNewReport: () => void }) {
  const t = useT();
  return (
    <div className="flex items-center gap-4 mb-8">
      <Bounce className="w-12 h-12 rounded-xl bg-blue-50 flex items-center justify-center">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="rgb(var(--zh-info))" strokeWidth="1.8">
          <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
          <polyline points="14 2 14 8 20 8" />
        </svg>
      </Bounce>
      <div>
        <h1 className="text-2xl font-bold text-zh-ink mb-1">{t('page.reports.title')}</h1>
        <p className="text-sm text-zh-muted">{t('page.reports.header.count', { count, date: new Date(latest.timestamp).toLocaleDateString() })}</p>
      </div>
      <PrimaryButton className="ml-auto" onClick={onNewReport}>
        {t('page.reports.header.generate')}
      </PrimaryButton>
    </div>
  );
}

export function LatestScoreCard({ latest, data }: { latest: HealthScoreData; data: HealthScoreData[] }) {
  useT();
  return (
    <ResultCard variant="score" className="flex gap-6 mb-6">
      <div className="flex items-center gap-4">
        <div
          className="w-16 h-16 rounded-full flex items-center justify-center text-xl font-bold text-white shrink-0"
          style={{ background: getScoreColor(latest.score) }}
        >
          {latest.score}
        </div>
        <div>
          <div className="text-sm font-semibold text-zh-ink-2">{getScoreLabel(latest.score)}</div>
          <div className="text-xs text-zh-muted mt-0.5">{new Date(latest.timestamp).toLocaleDateString()}</div>
        </div>
      </div>
      {data.length >= 2 && (
        <div className="flex-1 flex items-center justify-center border-l border-zh-line pl-6">
          <SparklineChart data={data} />
        </div>
      )}
    </ResultCard>
  );
}

export function DimensionCards({ dimensions }: { dimensions: HealthScoreData['dimensions'] }) {
  return (
    <div className="flex gap-4 mb-6">
      {dimensions.slice(0, 5).map((d) => (
        <ResultCard key={d.name} variant="stats" className="flex-1">
          <div className="text-xs text-zh-muted mb-1">{d.name}</div>
          <div className="text-lg font-bold" style={{ color: getScoreColor(d.score) }}>{d.score}</div>
          <div className="w-full h-1.5 rounded-full bg-zh-panel mt-2">
            <div className="h-full rounded-full" style={{ width: `${(d.weight || 0.5) * 100}%`, background: getScoreColor(d.score) }} />
          </div>
        </ResultCard>
      ))}
    </div>
  );
}

/** 模块级评分卡：monorepo 各子模块独立评分，按模块渲染（无子模块时不渲染） */
export function ModuleScoreCards({ modules }: { modules: ModuleScoreView[] }) {
  if (modules.length === 0) return null;
  return (
    <div className="flex gap-4 flex-wrap mb-6">
      {modules.map((m) => {
        const color = m.score == null ? 'rgb(var(--zh-muted))' : getScoreColor(m.score);
        const label = m.score == null ? '—' : getScoreLabel(m.score);
        return (
          <ResultCard key={m.path} variant="stats" className="min-w-[150px]">
            <div className="text-xs text-zh-muted mb-1 truncate" title={m.path}>{m.name}</div>
            <div className="flex items-center gap-2">
              <div
                className="w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold text-white shrink-0"
                style={{ background: color }}
              >
                {m.score == null ? '–' : m.score}
              </div>
              <div>
                <div className="text-xs font-semibold" style={{ color }}>{label}</div>
                <div className="text-[10px] text-zh-muted">{m.type}</div>
              </div>
            </div>
          </ResultCard>
        );
      })}
    </div>
  );
}
