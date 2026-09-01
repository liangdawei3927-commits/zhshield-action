import type { PipelineProgress } from '../types/electron';
import { CheckScopePanel, CheckRunButton, RunStatus } from './dashboard-panels';
import { useT } from '../i18n';

/** 健康圆环 SVG（null = 尚未体检，显示品牌色） */
export function HealthRing({ score }: { score: number | null }) {
  const t = useT();
  const radius = 60;
  const circumference = 2 * Math.PI * radius;
  const progress = score === null ? 0 : Math.min(Math.max(score, 0), 100);
  const offset = circumference - (progress / 100) * circumference;
  const color =
    score === null
      ? 'rgb(var(--zh-success))'
      : progress === 100
        ? 'rgb(var(--zh-success))'
        : progress >= 90
          ? 'rgb(var(--zh-info))'
          : progress >= 75
            ? 'rgb(var(--zh-brand-500))'
            : progress >= 60
              ? 'rgb(var(--zh-warning))'
              : 'rgb(var(--zh-danger))';

  return (
    <div className="relative w-[150px] h-[150px] flex items-center justify-center">
      <svg width="150" height="150" viewBox="0 0 150 150" className="absolute">
        <circle
          cx="75"
          cy="75"
          r={radius}
          fill="none"
          stroke={score === null ? 'rgb(var(--zh-success))' : 'rgb(var(--zh-line))'}
          strokeWidth="8"
          opacity={score === null ? 0.3 : 1}
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
        <div className="text-3xl font-bold" style={{ color }}>
          {score === null ? '--' : Math.round(progress)}
        </div>
        <div className="text-[10px] text-zh-muted mt-0.5">
          {score === null
            ? t('page.dashboard.ring.notChecked')
            : t('page.dashboard.ring.healthScore')}
        </div>
      </div>
    </div>
  );
}

/** 检查控制区：范围面板 + 执行按钮 + 运行状态 */
function HomeCheckControls({
  running,
  progressLabel,
  pipelineProgress,
  autoFixNotice,
  onCheck,
}: {
  running: boolean;
  progressLabel: string;
  pipelineProgress: PipelineProgress | null;
  autoFixNotice: string | null;
  onCheck: () => void;
}) {
  return (
    <>
      <CheckScopePanel />

      <CheckRunButton running={running} progressLabel={progressLabel} onCheck={onCheck} />

      <RunStatus
        running={running}
        pipelineProgress={pipelineProgress}
        autoFixNotice={autoFixNotice}
      />
    </>
  );
}

export function HomeView({
  score,
  running,
  progressLabel,
  pipelineProgress,
  autoFixNotice,
  onCheck,
}: {
  score: number | null;
  running: boolean;
  progressLabel: string;
  pipelineProgress: PipelineProgress | null;
  autoFixNotice: string | null;
  onCheck: () => void;
}) {
  const t = useT();
  return (
    <div className="h-full w-full bg-zh-bg relative overflow-auto">
      <div className="min-h-full flex flex-col items-center px-6 py-8 pb-6 select-none">
        <div className="flex-1 flex flex-col items-center justify-center min-h-0 w-full">
          <div className="flex items-center gap-12 mb-8">
            <HealthRing score={score} />
            <div className="flex flex-col">
              <div className="text-2xl font-bold text-zh-ink">{t('page.dashboard.welcome')}</div>
              <div className="text-sm text-zh-muted mt-2">{t('page.dashboard.guardSlogan')}</div>
            </div>
          </div>

          <HomeCheckControls
            running={running}
            progressLabel={progressLabel}
            pipelineProgress={pipelineProgress}
            autoFixNotice={autoFixNotice}
            onCheck={onCheck}
          />
        </div>

        <ProductIntro />
      </div>
    </div>
  );
}

function ProductIntro() {
  const t = useT();
  const axes = [
    {
      label: t('page.dashboard.axis.security.label'),
      desc: t('page.dashboard.axis.security.desc'),
      color: 'rgb(var(--zh-success))',
      icon: (
        <svg
          width="28"
          height="28"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 2L4 5v6c0 5 3.5 9 8 11 4.5-2 8-6 8-11V5l-8-3z" />
          <path d="M9 12l2 2 4-4" />
        </svg>
      ),
    },
    {
      label: t('page.dashboard.axis.governance.label'),
      desc: t('page.dashboard.axis.governance.desc'),
      color: 'rgb(var(--zh-brand))',
      icon: (
        <svg
          width="28"
          height="28"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="4" y="3" width="16" height="18" rx="2" />
          <path d="M8 10h8M8 14h5" />
          <path d="M8 7.5l1 1 2-2" />
        </svg>
      ),
    },
    {
      label: t('page.dashboard.axis.ops.label'),
      desc: t('page.dashboard.axis.ops.desc'),
      color: 'rgb(var(--zh-warning))',
      icon: (
        <svg
          width="28"
          height="28"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z" />
        </svg>
      ),
    },
  ];

  return (
    <div
      className="w-full h-[89px] rounded-2xl px-8 flex items-center justify-between gap-8 shrink-0"
      style={{
        background:
          'linear-gradient(135deg, rgb(var(--zh-brand-900)) 0%, rgb(var(--zh-brand-hover)) 60%, rgb(var(--zh-brand-600)) 100%)',
        boxShadow: '0 8px 24px rgb(var(--zh-brand-900) / 0.18)',
      }}
    >
      <div className="flex items-center gap-4 min-w-0">
        <span
          className="shrink-0 w-10 h-10 rounded-xl flex items-center justify-center text-white"
          style={{ background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)' }}
        >
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 2L4 5v6c0 5 3.5 9 8 11 4.5-2 8-6 8-11V5l-8-3z" />
          </svg>
        </span>
        <div className="min-w-0">
          <div className="text-xl font-bold text-white tracking-wide">
            {t('page.dashboard.productIntro.title')}
          </div>
          <div className="text-xs mt-1.5" style={{ color: 'rgba(255,255,255,0.65)' }}>
            {t('page.dashboard.productIntro.subtitle')}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3 shrink-0">
        {axes.map((item) => (
          <div
            key={item.label}
            className="flex items-center gap-3 px-5 py-3 rounded-xl"
            style={{
              background: 'rgba(255,255,255,0.08)',
              border: '1px solid rgba(255,255,255,0.14)',
            }}
          >
            <span style={{ color: item.color }}>{item.icon}</span>
            <span>
              <span className="block text-base font-semibold text-white leading-none whitespace-nowrap">
                {item.label}
              </span>
              <span
                className="block text-sm mt-1.5 leading-none whitespace-nowrap"
                style={{ color: 'rgba(255,255,255,0.6)' }}
              >
                {item.desc}
              </span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
