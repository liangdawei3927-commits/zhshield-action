import type { DashboardCard } from '../types/electron';
import { useT } from '../i18n';
import { ResultCard } from '../components/ui/ResultCard';

const GAUGE_START = 135; // 仪表起点角（左下，0 分）
const GAUGE_END = 45; // 仪表终点角（右下，100 分），经顶部顺时针 270°
const SWEEP = 270;

function polar(cx: number, cy: number, r: number, deg: number): { x: number; y: number } {
  const rad = (deg * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function arcPath(cx: number, cy: number, r: number): string {
  const start = polar(cx, cy, r, GAUGE_START);
  const end = polar(cx, cy, r, GAUGE_END);
  return `M ${start.x} ${start.y} A ${r} ${r} 0 1 1 ${end.x} ${end.y}`;
}

/** 健康评分仪表（270° 汽车仪表式弧，底部开口标注 健/康/分）；null = 尚未体检 */
export function HealthRing({ score, size = 150 }: { score: number | null; size?: number }) {
  const t = useT();
  const progress = score === null ? 0 : Math.min(Math.max(score, 0), 100);
  /* 颜色阈值与 scoring 的 gradeOf 严格同源（A>=90/B>=75/C>=60/D），保证环色与等级徽章一致 */
  const color =
    score === null
      ? 'rgb(var(--zh-brand))'
      : progress >= 90
        ? 'rgb(var(--zh-success))'
        : progress >= 75
          ? 'rgb(var(--zh-info))'
          : progress >= 60
            ? 'rgb(var(--zh-warning))'
            : 'rgb(var(--zh-danger))';

  const r = 54;
  const arcLen = (SWEEP / 360) * 2 * Math.PI * r;
  const offset = arcLen * (1 - progress / 100);
  const labelY = 110; // 底部刻度基线（150 视口坐标，圆内下部）
  const cx = 75;
  const cy = 75;

  return (
    <div
      className="relative flex items-center justify-center"
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} viewBox="0 0 150 150" className="absolute">
        {/* 淡光晕底：与质量巡检/安全中心等页插图同密度，抵消细环的视觉单薄 */}
        <circle cx="75" cy="75" r="64" fill="rgb(var(--zh-brand) / 0.05)" />
        {/* 量程底弧（270°，底部开口 = 0 分起始位） */}
        <path
          d={arcPath(cx, cy, r)}
          fill="none"
          stroke={score === null ? 'rgb(var(--zh-brand))' : 'rgb(var(--zh-line))'}
          strokeWidth="8"
          strokeLinecap="round"
          opacity={score === null ? 0.25 : 1}
        />
        {/* 进度弧：从健侧（135°）顺时针扫向分侧（45°），满分正好画满 270° */}
        {score !== null && (
          <path
            d={arcPath(cx, cy, r)}
            fill="none"
            stroke={color}
            strokeWidth="8"
            strokeLinecap="round"
            strokeDasharray={arcLen}
            strokeDashoffset={offset}
            style={{ transition: 'stroke-dashoffset 1s ease-out' }}
          />
        )}
        {/* 底部刻度 评/分（0/100）：左端起点、右端终点，开口中央留空 */}
        <text
          x={75 - 42}
          y={labelY}
          textAnchor="middle"
          fill="rgb(var(--zh-muted))"
          style={{ fontSize: 11 }}
        >
          {t('page.dashboard.ring.gaugeMin')}
        </text>
        <text
          x={75 + 42}
          y={labelY}
          textAnchor="middle"
          fill="rgb(var(--zh-muted))"
          style={{ fontSize: 11 }}
        >
          {t('page.dashboard.ring.gaugeMax')}
        </text>
      </svg>
      <div className="relative z-10 text-center">
        <div className="font-bold leading-none" style={{ fontSize: size * 0.33, color }}>
          {score === null ? '--' : Math.round(progress)}
        </div>
      </div>
    </div>
  );
}

/** 六卡标题文案键（顺序与 engines.ts 卡片构造一致：quality/gate/security/deps/techdebt/sentinel） */
const CARD_TITLE_KEYS: Record<DashboardCard['key'], string> = {
  quality: 'page.dashboard.card.quality',
  gate: 'page.dashboard.card.gate',
  security: 'page.dashboard.card.security',
  dependencies: 'page.dashboard.card.dependencies',
  techdebt: 'page.dashboard.card.techdebt',
  sentinel: 'page.dashboard.card.sentinel',
};

/** 六卡评分权重（%）：与 engines.ts DASHBOARD_CARD_WEIGHTS 严格同源（方案 §4.3） */
const CARD_WEIGHTS_PCT: Record<DashboardCard['key'], number> = {
  quality: 35,
  security: 25,
  dependencies: 15,
  techdebt: 15,
  gate: 5,
  sentinel: 5,
};

/** 卡面分数颜色：与 HealthRing / scoring.gradeOf 同源（A>=90/B>=75/C>=60/D），保证全站一致 */
function scoreColor(score: number): string {
  return score >= 90
    ? 'rgb(var(--zh-success))'
    : score >= 75
      ? 'rgb(var(--zh-info))'
      : score >= 60
        ? 'rgb(var(--zh-warning))'
        : 'rgb(var(--zh-danger))';
}

function formatLastRun(
  t: (key: string, params?: Record<string, unknown>) => string,
  lastRunAt?: string,
): string {
  if (!lastRunAt) return t('page.dashboard.card.neverRun');
  const diff = Date.now() - new Date(lastRunAt).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return t('page.dashboard.card.justNow');
  if (minutes < 60) return t('page.dashboard.card.minutesAgo', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('page.dashboard.card.hoursAgo', { count: hours });
  return t('page.dashboard.card.lastRun', { time: new Date(lastRunAt).toLocaleString() });
}

/** 健康画像六卡网格：一键全检后的分域结果总览（复用 ResultCard 全局卡片样式） */
export function DashboardCards({ cards }: { cards: DashboardCard[] }) {
  const t = useT();
  return (
    <div className="w-full max-w-4xl mt-8 grid grid-cols-3 gap-3">
      {cards.map((card) => {
        const notRun = card.status === 'not-run';
        const expired = card.status === 'expired';
        const statusPill = notRun
          ? 'text-zh-muted bg-zh-line'
          : expired
            ? 'text-warning-700 bg-warning-50'
            : 'text-success-700 bg-success-50';
        const statusLabel = notRun
          ? t('page.dashboard.status.notRun')
          : expired
            ? t('page.dashboard.status.expired')
            : t('page.dashboard.card.justNow');
        return (
          <ResultCard key={card.key} variant="stats" className="flex flex-col gap-1">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-semibold text-zh-ink truncate">
                {t(CARD_TITLE_KEYS[card.key])}
              </span>
              <span className={`shrink-0 px-2 py-0.5 rounded-full text-[11px] font-medium ${statusPill}`}>
                {statusLabel}
              </span>
            </div>
            <div className="flex items-baseline gap-1">
              <span
                className="text-2xl font-bold leading-none"
                style={{ color: card.score !== undefined ? scoreColor(card.score) : 'rgb(var(--zh-muted))' }}
              >
                {card.score !== undefined ? Math.round(card.score) : '--'}
              </span>
              {card.score !== undefined && (
                <span className="text-xs text-zh-muted">{t('page.dashboard.card.score', { score: Math.round(card.score) })}</span>
              )}
            </div>
            <div className="text-xs text-zh-muted">
              {notRun
                ? t('page.dashboard.card.neverRun')
                : t('page.dashboard.card.issues', { count: card.issues ?? 0 })}
            </div>
            <div className="mt-1 pt-1.5 border-t border-zh-line flex items-center justify-between gap-2 text-[11px]">
              <span className="text-zh-muted">
                {card.key === 'sentinel'
                  ? t('page.dashboard.card.weightExcluded')
                  : t('page.dashboard.card.weightTip', { pct: CARD_WEIGHTS_PCT[card.key] })}
              </span>
              <span className="text-zh-muted truncate">{formatLastRun(t, card.lastRunAt)}</span>
            </div>
          </ResultCard>
        );
      })}
    </div>
  );
}
