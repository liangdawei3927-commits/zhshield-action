import { useT } from '../../i18n';
import { getScoreColor } from './score-grade';

const R = 54; // 环半径（150 视口坐标）
const CIRCUMFERENCE = 2 * Math.PI * R;

/**
 * 健康评分环（完整 360° 圆环）：浅色轨道 + 等级色进度弧（自顶部顺时针，弧长=得分比例）
 * + 环心得分数字；null = 尚未体检。
 *
 * 颜色阈值与 scoring 的 gradeOf 严格同源（A>=90 success / B>=75 info / C>=60 warning /
 * D<60 danger），保证环色与等级徽章一致；score=null 时灰色占位并显示 '--'。
 */
export function HealthRing({ score, size = 260 }: { score: number | null; size?: number }) {
  const t = useT();
  const progress = score === null ? 0 : Math.min(Math.max(score, 0), 100);
  const color = score === null ? 'rgb(var(--zh-muted))' : getScoreColor(progress);
  const arcLen = (CIRCUMFERENCE * progress) / 100;
  const cx = 75;
  const cy = 75;
  // 数字宽度自适应：3 位（100 分）降档，避免数字+单位超出环内径贴到圆弧
  const numberFont = (score === null ? 2 : String(Math.round(progress)).length) >= 3
    ? size * 0.26
    : size * 0.33;

  return (
    <div
      className="relative flex items-center justify-center"
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} viewBox="0 0 150 150" className="absolute">
        {/* 淡光晕底：与质量巡检/安全中心等页插图同密度，抵消细环的视觉单薄 */}
        <circle cx="75" cy="75" r="64" fill="rgb(var(--zh-brand) / 0.05)" />
        {/* 全圆轨道（浅色） */}
        <circle
          cx={cx}
          cy={cy}
          r={R}
          fill="none"
          stroke={score === null ? 'rgb(var(--zh-muted))' : 'rgb(var(--zh-line))'}
          strokeWidth="8"
          opacity={score === null ? 0.25 : 1}
        />
        {/* 得分进度弧：自顶部（12 点）顺时针，弧长=得分比例，等级色 */}
        {score !== null && (
          <circle
            cx={cx}
            cy={cy}
            r={R}
            fill="none"
            stroke={color}
            strokeWidth="8"
            strokeLinecap="round"
            strokeDasharray={`${arcLen} ${CIRCUMFERENCE}`}
            transform={`rotate(-90 ${cx} ${cy})`}
            style={{ transition: 'stroke-dasharray 1s ease-out' }}
          />
        )}
      </svg>
      <div className="relative z-10 flex items-baseline justify-center">
        <span className="font-bold leading-none" style={{ fontSize: numberFont, color }}>
          {score === null ? '--' : Math.round(progress)}
        </span>
        {score !== null && (
          <span
            style={{
              fontSize: size * 0.1,
              color: 'rgb(var(--zh-muted))',
              marginLeft: 2,
            }}
          >
            {t('page.domainScore.unit')}
          </span>
        )}
      </div>
    </div>
  );
}