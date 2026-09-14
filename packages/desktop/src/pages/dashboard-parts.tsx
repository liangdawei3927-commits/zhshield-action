import { useT } from '../i18n';

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
        {/* 底部刻度 健/康/分（0/50/100） */}
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
          x={75}
          y={labelY}
          textAnchor="middle"
          fill="rgb(var(--zh-muted))"
          style={{ fontSize: 11 }}
        >
          {t('page.dashboard.ring.gaugeMid')}
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
