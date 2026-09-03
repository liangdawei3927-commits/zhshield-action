import { useEffect, useState } from 'react';
import { SectionTitle } from './sidebar-interactive';
import { BounceCard } from '../ui/Bounce';
import { useT } from '../../i18n';

export interface EngineCardProps {
  intelligentEnabled: boolean;
  setIntelligentEnabled: (enabled: boolean) => void;
  intelligentLoading: boolean;
}

/** 智能引擎卡：标题「智能引擎」+ 副标题 + 总开关，一键联动门禁+哨兵 */
export function EngineStatusSection({
  intelligentEnabled,
  setIntelligentEnabled,
  intelligentLoading,
}: EngineCardProps) {
  const t = useT();
  return (
    <section>
      <SectionTitle
        label={t('layout.engineStatus')}
        icon={
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect width="16" height="16" x="4" y="4" rx="2" />
            <rect width="6" height="6" x="9" y="9" rx="1" />
            <path d="M15 2v2M15 20v2M2 15h2M2 9h2M20 15h2M20 9h2M9 2v2M9 20v2" />
          </svg>
        }
      />
      <BounceCard className="rounded-xl bg-zh-panel/60 p-3 space-y-2">
        <div className="flex items-center gap-2.5">
          <div className="flex-1 min-w-0">
            <div className="text-xs font-medium text-zh-ink truncate">
              {intelligentEnabled ? t('layout.engineIdle') : t('layout.engineOff')}
            </div>
          </div>
          <button
            type="button"
            onClick={() => setIntelligentEnabled(!intelligentEnabled)}
            disabled={intelligentLoading}
            aria-label={t('layout.engineStatus')}
            className={`shrink-0 w-9 h-5 rounded-full p-0.5 transition-colors border cursor-pointer ${
              intelligentLoading ? 'opacity-50 cursor-wait' : ''
            } ${intelligentEnabled ? 'bg-success-700 border-success-700' : 'bg-zh-ink-2/20 border-zh-ink-2/30'}`}
          >
            <span
              className={`block w-4 h-4 rounded-full shadow-sm transition-transform ${
                intelligentEnabled ? 'bg-white translate-x-4' : 'bg-zh-ink-2/60 translate-x-0'
              }`}
            />
          </button>
        </div>
        <p className="text-[11px] leading-relaxed text-zh-muted">
          {intelligentEnabled ? t('layout.engineSubtitle') : t('layout.enginePromptOff')}
        </p>
      </BounceCard>
    </section>
  );
}

/** 智汇大脑卡：云协同状态展示（SOP 规则下发 / 经验回写），不设开关，常驻服务 */
export function WisdomBrainCard() {
  const t = useT();
  const [level, setLevel] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.electronAPI?.sop
      ?.getSyncHealth()
      .then((h) => {
        if (!cancelled) setLevel(h?.level ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const status =
    level === null || level === 0
      ? { text: t('layout.brainHealthy'), dot: 'bg-success-700' }
      : level <= 3
        ? { text: t('layout.brainUpdating'), dot: 'bg-warning-500' }
        : { text: t('layout.brainStale'), dot: 'bg-danger-600' };

  return (
    <section>
      <SectionTitle
        label={t('layout.brainTitle')}
        icon={
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
            <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
            <path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4" />
          </svg>
        }
      />
      <BounceCard className="rounded-xl bg-zh-panel/60 p-3 space-y-2">
        <div className="flex items-center gap-2">
          <span className={`w-1.5 h-1.5 rounded-full ${status.dot}`} />
          <span className="text-xs font-medium text-zh-ink">
            {level === null ? t('layout.brainChecking') : status.text}
          </span>
        </div>
        <p className="text-[11px] leading-relaxed text-zh-muted">{t('layout.brainSubtitle')}</p>
      </BounceCard>
    </section>
  );
}
