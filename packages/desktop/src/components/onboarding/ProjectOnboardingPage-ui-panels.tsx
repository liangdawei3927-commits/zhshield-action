// 项目引导页面板 UI 组件
import { type ReactNode, useState } from 'react';
import type {
  OnboardingProfileSummary,
  RuleSyncSummary,
  ToolsStatusSummary,
  TFunc,
  ToolRowStatus,
} from './ProjectOnboardingPage-types';
import { LOW_CONFIDENCE_THRESHOLD, ONBOARDING_PRESETS } from './ProjectOnboardingPage-types';

/** 面板底部主按钮：品牌渐变 + 悬停透明度反馈（预设选择 / 画像确认两处共用） */
export function OnboardingPanelAction({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full py-2.5 rounded-lg text-sm font-medium text-white transition-all duration-200 cursor-pointer"
      style={{
        background:
          'linear-gradient(135deg, rgb(var(--zh-brand)) 0%, rgb(var(--zh-brand-hover)) 100%)',
        boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.opacity = '0.9';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.opacity = '1';
      }}
    >
      {children}
    </button>
  );
}

export function OnboardingPresetSelector({
  presets,
  selectedPreset,
  onSelect,
  onConfirm,
}: {
  presets: { id: string; label: string; desc: string; icon: string }[];
  selectedPreset: string | null;
  onSelect: (id: string) => void;
  onConfirm: () => void;
}) {
  return (
    <div className="mt-6 w-80">
      <div
        className="rounded-xl p-5"
        style={{ background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)' }}
      >
        <div className="text-white text-sm font-semibold mb-4 text-center">选择治理预设</div>
        <div className="grid grid-cols-3 gap-3 mb-4">
          {presets.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => onSelect(preset.id)}
              className={`flex flex-col items-center gap-2 p-3 rounded-lg transition-all duration-200 cursor-pointer ${
                selectedPreset === preset.id
                  ? 'bg-white/20 border border-white/50'
                  : 'bg-white/5 border border-white/10 hover:bg-white/10'
              }`}
            >
              <span className="text-2xl">{preset.icon}</span>
              <span className="text-white text-xs font-medium leading-tight text-center">
                {preset.label}
              </span>
              <span className="text-white/50 text-[10px] leading-tight text-center">
                {preset.desc}
              </span>
            </button>
          ))}
        </div>
        <OnboardingPanelAction onClick={onConfirm}>确认选择</OnboardingPanelAction>
      </div>
    </div>
  );
}

/** 画像确认面板行：标签 + 值（值缺失显示通用兜底文案） */
export function ProfileConfirmRow({
  label,
  value,
  t,
}: {
  label: string;
  value?: string;
  t: (key: string) => string;
}) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-white/60 text-xs">{label}</span>
      <span className="text-white text-xs font-medium">
        {value ?? t('page.onboarding.profileConfirm.unknown')}
      </span>
    </div>
  );
}

/** 画像人工核对确认面板（06-多语言自适应架构 §七：首次注册必选确认，确认一次永久生效） */
export function OnboardingProfileConfirm({
  summary,
  onConfirm,
  t,
}: {
  summary: OnboardingProfileSummary;
  onConfirm: () => void;
  t: (key: string, params?: Record<string, unknown>) => string;
}) {
  const lowConfidence = (summary.confidence ?? 1) < LOW_CONFIDENCE_THRESHOLD;
  return (
    <div className="mt-6 w-80">
      <div
        className="rounded-xl p-5"
        style={{ background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)' }}
      >
        <div className="text-white text-sm font-semibold mb-3 text-center">
          {t('page.onboarding.profileConfirm.title')}
        </div>
        <div className="mb-3 divide-y divide-white/10">
          <ProfileConfirmRow
            label={t('page.onboarding.profileConfirm.language')}
            value={summary.language}
            t={t}
          />
          <ProfileConfirmRow
            label={t('page.onboarding.profileConfirm.framework')}
            value={summary.framework}
            t={t}
          />
          <ProfileConfirmRow
            label={t('page.onboarding.profileConfirm.architecture')}
            value={summary.architecture}
            t={t}
          />
          {summary.confidence !== undefined && (
            <ProfileConfirmRow
              label={t('page.onboarding.profileConfirm.confidence')}
              value={`${Math.round(summary.confidence * 100)}%`}
              t={t}
            />
          )}
        </div>
        {lowConfidence && (
          <div className="mb-3 text-center text-[11px] leading-snug text-amber-300">
            {t('page.onboarding.profileConfirm.lowConfidence')}
          </div>
        )}
        <OnboardingPanelAction onClick={onConfirm}>
          {t('page.onboarding.profileConfirm.confirmBtn')}
        </OnboardingPanelAction>
      </div>
    </div>
  );
}

/** 云端规则差量同步摘要（sync:resolveRules 结果，失败/离线时提示降级） */
export function OnboardingRuleSyncSummary({
  summary,
  t,
}: {
  summary: RuleSyncSummary;
  t: (key: string, params?: Record<string, unknown>) => string;
}) {
  return (
    <div className="mt-4 w-72 text-center text-xs">
      {summary.ok ? (
        <span className="text-white/70">
          {t('page.onboarding.ruleSync.summary', {
            total: summary.total,
            changed: summary.changedCount,
          })}
        </span>
      ) : (
        <span className="text-white/40">{t('page.onboarding.ruleSync.offline')}</span>
      )}
    </div>
  );
}

/** 工具就绪状态行标签 */
export function toolStatusLabel(status: ToolRowStatus, t: TFunc): string {
  return t(`page.onboarding.tools.st.${status}`);
}

/** 工具安装区：缺失项安装按钮 + 全部就绪/安装结果提示（工具就绪面板底部） */
export function OnboardingToolsInstall({
  missing,
  installing,
  done,
  readyCount,
  onInstall,
  t,
}: {
  missing: ToolsStatusSummary['tools'];
  installing: boolean;
  done: 'ok' | 'fail' | null;
  readyCount: number;
  onInstall: () => void;
  t: TFunc;
}) {
  return (
    <>
      {missing.length > 0 ? (
        <button
          type="button"
          onClick={onInstall}
          disabled={installing}
          className="mt-3 w-full py-2 rounded-lg text-xs font-medium text-white transition-all duration-200 cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
          style={{
            background:
              'linear-gradient(135deg, rgb(var(--zh-brand)) 0%, rgb(var(--zh-brand-hover)) 100%)',
          }}
        >
          {installing
            ? t('page.onboarding.tools.installing')
            : t('page.onboarding.tools.install', { count: missing.length })}
        </button>
      ) : (
        <div className="mt-3 text-center text-[11px] text-success-400">
          {t('page.onboarding.tools.allReady', { count: readyCount })}
        </div>
      )}
      {done === 'ok' && (
        <div className="mt-2 text-center text-[11px] text-success-400">
          {t('page.onboarding.tools.installDone')}
        </div>
      )}
      {done === 'fail' && (
        <div className="mt-2 text-center text-[11px] text-amber-300">
          {t('page.onboarding.tools.installFailed')}
        </div>
      )}
    </>
  );
}

/** 工具就绪面板（工具半自动原则：展示三层探测状态，缺失项由用户点击确认后安装） */
export function OnboardingToolsPanel({
  status,
  onRefresh,
  t,
}: {
  status: ToolsStatusSummary;
  onRefresh: () => Promise<void>;
  t: TFunc;
}) {
  const [installing, setInstalling] = useState(false);
  const [done, setDone] = useState<'ok' | 'fail' | null>(null);
  const missing = status.tools.filter((row) => row.status === 'missing');
  const readyCount = status.tools.length - missing.length;

  async function handleInstall(): Promise<void> {
    setInstalling(true);
    setDone(null);
    try {
      const res = await window.electronAPI?.tools?.install(missing.map((row) => row.toolId));
      await onRefresh();
      setDone(res?.ok ? 'ok' : 'fail');
    } catch {
      setDone('fail');
    } finally {
      setInstalling(false);
    }
  }

  return (
    <div className="mt-4 w-80">
      <div
        className="rounded-xl p-4"
        style={{ background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)' }}
      >
        <div className="flex items-center justify-between mb-2">
          <span className="text-white text-xs font-semibold">
            {t('page.onboarding.tools.title')}
          </span>
          <span className="text-white/40 text-[10px]">
            {status.source === 'cloud'
              ? t('page.onboarding.tools.sourceCloud')
              : t('page.onboarding.tools.sourceLocal')}
          </span>
        </div>
        <div className="flex flex-col gap-1.5">
          {status.tools.map((row) => (
            <div key={row.toolId} className="flex items-center justify-between">
              <span className="text-white/80 text-xs font-mono">{row.toolId}</span>
              <span
                className={`text-[10px] px-2 py-0.5 rounded-full ${
                  row.status === 'missing'
                    ? 'bg-amber-500/20 text-amber-300'
                    : 'bg-success-500/20 text-success-400'
                }`}
              >
                {toolStatusLabel(row.status, t)}
              </span>
            </div>
          ))}
        </div>
        <OnboardingToolsInstall
          missing={missing}
          installing={installing}
          done={done}
          readyCount={readyCount}
          onInstall={handleInstall}
          t={t}
        />
      </div>
    </div>
  );
}
