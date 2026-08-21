import { useT } from '../../i18n';

interface ScoreRingProps {
  score: number;
  size?: number;
}

export function ScoreRing({ score, size = 160 }: ScoreRingProps) {
  const t = useT();
  const circumference = 2 * Math.PI * 45;
  const offset = circumference - (score / 100) * circumference;
  const grade = score >= 90 ? t('score.gradeExcellent') : score >= 75 ? t('score.gradeGood') : score >= 60 ? t('score.gradePass') : t('score.gradeWarning');
  const gradeColor = score >= 90 ? 'rgb(var(--zh-success))' : score >= 75 ? 'rgb(var(--zh-info))' : score >= 60 ? 'rgb(var(--zh-warning))' : 'rgb(var(--zh-danger))';
  const gradeLetter = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : 'D';

  return (
    <div className="relative flex items-center justify-center" style={{ width: size, height: size }}>
      <svg className="w-full h-full transform -rotate-90" viewBox="0 0 100 100">
        <circle cx="50" cy="50" r="45" fill="none" stroke="rgb(var(--zh-brand-lighter))" strokeWidth="8" />
        <circle cx="50" cy="50" r="38" fill="none" stroke="rgb(var(--zh-brand-lighter))" strokeWidth="3" />
        <circle
          cx="50" cy="50" r="45"
          fill="none"
          stroke={gradeColor}
          strokeWidth="8"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-bold" style={{ fontSize: size * 0.22, color: gradeColor, lineHeight: 1 }}>
          {score}
        </span>
        <span className="font-semibold mt-0.5" style={{ fontSize: size * 0.08, color: gradeColor }}>
          {t('score.gradeBadge', { letter: gradeLetter, grade })}
        </span>
      </div>
    </div>
  );
}
