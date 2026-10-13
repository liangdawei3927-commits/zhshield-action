import { useT } from '../../i18n';
import { getScoreColor } from './score-grade';

interface ScoreRingProps {
  score: number;
  size?: number;
}

export function ScoreRing({ score, size = 160 }: ScoreRingProps) {
  const t = useT();
  const circumference = 2 * Math.PI * 45;
  // 与 HealthRing 同口径收敛到 [0,100]：进度弧按 score/100 算 dashoffset，
  // 越界值（>100 或 NaN）会得到负/非法偏移，弧整个画不出来
  const progress = Math.min(Math.max(Number.isFinite(score) ? score : 0, 0), 100);
  const offset = circumference - (progress / 100) * circumference;
  const grade =
    progress >= 90
      ? t('score.gradeExcellent')
      : progress >= 75
        ? t('score.gradeGood')
        : progress >= 60
          ? t('score.gradePass')
          : t('score.gradeWarning');
  const gradeColor = getScoreColor(progress);
  const gradeLetter = progress >= 90 ? 'A' : progress >= 75 ? 'B' : progress >= 60 ? 'C' : 'D';

  return (
    <div
      className="relative flex items-center justify-center"
      style={{ width: size, height: size }}
    >
      <svg className="w-full h-full transform -rotate-90" viewBox="0 0 100 100">
        <circle
          cx="50"
          cy="50"
          r="45"
          fill="none"
          stroke="rgb(var(--zh-brand-lighter))"
          strokeWidth="8"
        />
        <circle
          cx="50"
          cy="50"
          r="38"
          fill="none"
          stroke="rgb(var(--zh-brand-lighter))"
          strokeWidth="3"
        />
        <circle
          cx="50"
          cy="50"
          r="45"
          fill="none"
          stroke={gradeColor}
          strokeWidth="8"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span
          className="font-bold"
          style={{ fontSize: size * 0.22, color: gradeColor, lineHeight: 1 }}
        >
          {progress}
        </span>
        <span className="font-semibold mt-0.5" style={{ fontSize: size * 0.08, color: gradeColor }}>
          {t('score.gradeBadge', { letter: gradeLetter, grade })}
        </span>
      </div>
    </div>
  );
}
