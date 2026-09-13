import { useT } from '../i18n';

/** 健康圆环 SVG（null = 尚未体检，显示品牌色）；size 控制渲染尺寸，默认 150 */
export function HealthRing({ score, size = 150 }: { score: number | null; size?: number }) {
  const t = useT();
  const radius = 60;
  const circumference = 2 * Math.PI * radius;
  const progress = score === null ? 0 : Math.min(Math.max(score, 0), 100);
  const offset = circumference - (progress / 100) * circumference;
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

  return (
    <div
      className="relative flex items-center justify-center"
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} viewBox="0 0 150 150" className="absolute">
        {/* 淡光晕底：与质量巡检/安全中心等页插图同密度，抵消细环的视觉单薄 */}
        <circle
          cx="75"
          cy="75"
          r="64"
          fill="rgb(var(--zh-brand) / 0.05)"
        />
        <circle
          cx="75"
          cy="75"
          r={radius}
          fill="none"
          stroke={score === null ? 'rgb(var(--zh-brand))' : 'rgb(var(--zh-line))'}
          strokeWidth="8"
          opacity={score === null ? 0.25 : 1}
        />
        {score !== null && (
          <circle
            cx="75"
            cy="75"
            r={radius}
            fill="none"
            stroke={color}
            strokeWidth="8"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            transform="rotate(-90 75 75)"
            style={{ transition: 'stroke-dashoffset 1s ease-out' }}
          />
        )}
      </svg>
      <div className="relative z-10 text-center">
        <div className="font-bold leading-none" style={{ fontSize: size * 0.2, color }}>
          {score === null ? '--' : Math.round(progress)}
        </div>
        <div className="text-zh-muted mt-1" style={{ fontSize: size * 0.066 }}>
          {score === null
            ? t('page.dashboard.ring.notChecked')
            : t('page.dashboard.ring.healthScore')}
        </div>
      </div>
    </div>
  );
}
