import type { ReactNode } from 'react';
import { useT } from '../i18n';

/** 三轴元数据：安全 / 治理 / 运维（顺序与原版 ProductIntro 一致） */
type AxisKey = 'security' | 'governance' | 'ops';

const AXIS_ORDER: AxisKey[] = ['security', 'governance', 'ops'];

const AXIS_META: Record<AxisKey, { color: string; icon: ReactNode }> = {
  security: {
    color: 'rgb(var(--zh-success))',
    icon: (
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2L4 5v6c0 5 3.5 9 8 11 4.5-2 8-6 8-11V5l-8-3z" /><path d="M9 12l2 2 4-4" />
      </svg>
    ),
  },
  governance: {
    color: 'rgb(var(--zh-brand))',
    icon: (
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 10h8M8 14h5" /><path d="M8 7.5l1 1 2-2" />
      </svg>
    ),
  },
  ops: {
    color: 'rgb(var(--zh-warning))',
    icon: (
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z" />
      </svg>
    ),
  },
};

/**
 * 体检页底部守护者长卡 — 恢复原版 ProductIntro：深色渐变横幅，
 * 左侧「代码界的智能卫士」代言区，右侧 安全/治理/运维 三轴入口卡。
 */
export function GuardianFooter() {
  const t = useT();

  return (
    <div className="w-full flex flex-col items-center mt-auto mb-10 px-6">
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
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2L4 5v6c0 5 3.5 9 8 11 4.5-2 8-6 8-11V5l-8-3z" />
            </svg>
          </span>
          <div className="min-w-0">
            <div className="text-xl font-bold text-white tracking-wide">{t('page.dashboard.productIntro.title')}</div>
            <div className="text-xs mt-1.5" style={{ color: 'rgba(255,255,255,0.65)' }}>{t('page.dashboard.productIntro.subtitle')}</div>
          </div>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          {AXIS_ORDER.map((key) => {
            const axis = AXIS_META[key];
            return (
              <div
                key={key}
                className="flex items-center gap-3 px-5 py-3 rounded-xl"
                style={{ background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.14)' }}
              >
                <span style={{ color: axis.color }}>{axis.icon}</span>
                <span>
                  <span className="block text-base font-semibold text-white leading-none whitespace-nowrap">
                    {t(`page.dashboard.axis.${key}.label`)}
                  </span>
                  <span className="block text-sm mt-1.5 leading-none whitespace-nowrap" style={{ color: 'rgba(255,255,255,0.6)' }}>
                    {t(`page.dashboard.axis.${key}.desc`)}
                  </span>
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}