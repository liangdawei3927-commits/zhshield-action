import { useState, useEffect } from 'react';
import { ShieldLogo } from '../ui/Icons';
import { useT } from '../../i18n';

interface ProjectOnboardingPageProps {
  projectName: string;
  projectPath: string;
  onComplete: () => void;
  onClose?: () => void;
  intelligentEnabled?: boolean;
}

/** 画像确认面板展示用投影（来自 engine:runProfile 的 fingerprint ProjectProfile） */
export interface OnboardingProfileSummary {
  language?: string;
  framework?: string;
  architecture?: string;
  /** 探测置信度 0-1（主语言判定），低于 0.6 时 UI 提示人工核对 */
  confidence?: number;
}

/** 云端规则差量同步摘要（/resolve/rules 结果） */
export interface RuleSyncSummary {
  ok: boolean;
  total: number;
  changedCount: number;
}

/** 低置信度阈值：低于此值确认面板需提示人工核对（对齐 06-多语言自适应架构 §七） */
const LOW_CONFIDENCE_THRESHOLD = 0.6;

interface Step {
  id: string;
  labelKey: string;
  execute: () => Promise<void>;
  icon: JSX.Element;
}

/** 将 fingerprint ProjectProfile 投影为确认面板数据（无 targets 返回 null） */
function toProfileSummary(result: unknown): OnboardingProfileSummary | null {
  const profile = (
    result as { profile?: { targets?: unknown[]; architecture?: { value?: string } } }
  )?.profile;
  const target = profile?.targets?.[0] as
    | {
        language?: { value?: string; confidence?: number };
        frameworks?: Array<{ value?: string }>;
      }
    | undefined;
  if (!target) return null;
  return {
    language: target.language?.value,
    framework: target.frameworks?.[0]?.value,
    architecture: profile?.architecture?.value,
    confidence: target.language?.confidence,
  };
}

function buildSteps(
  projectPath: string,
  presetConfirmed: boolean,
  selectedPreset: string | null,
  profileDetected: boolean,
  profileConfirmed: boolean,
  onProfileDetected: (summary: OnboardingProfileSummary | null) => void,
  onRuleSyncResult: (summary: RuleSyncSummary) => void,
): Step[] {
  return [
    {
      id: 'analyze',
      labelKey: 'page.onboarding.step.analyze',
      execute: async () => {
        const result = await window.electronAPI?.engine?.runProfile(projectPath);
        onProfileDetected(toProfileSummary(result));
      },
      icon: (
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.35-4.35" />
        </svg>
      ),
    },
    {
      id: 'confirm',
      labelKey: 'page.onboarding.step.confirm',
      execute: async () => {
        // 画像未识别（null）时无需确认，直接进入同步；已识别则等待用户确认
        if (!profileDetected) return;
        await new Promise<void>((resolve) => {
          const check = setInterval(() => {
            if (profileConfirmed) {
              clearInterval(check);
              resolve();
            }
          }, 100);
        });
      },
      icon: (
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M9 12l2 2 4-4" />
          <path d="M21 12c.552 0 1-.448 1-1V8.5L12 3 2 8.5V11c0 5.523 4.477 10 10 10 2.145 0 4.13-.676 5.76-1.826" />
        </svg>
      ),
    },
    {
      id: 'profile',
      labelKey: 'page.onboarding.step.profile',
      execute: async () => {
        await window.electronAPI?.sync?.syncRules();
        const outcome = await window.electronAPI?.sync?.resolveRules();
        onRuleSyncResult({
          ok: outcome?.ok ?? false,
          total: outcome?.total ?? 0,
          changedCount: outcome?.changed?.length ?? 0,
        });
      },
      icon: (
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" y1="13" x2="8" y2="13" />
          <line x1="16" y1="17" x2="8" y2="17" />
          <polyline points="10 9 9 9 8 9" />
        </svg>
      ),
    },
    {
      id: 'skills',
      labelKey: 'page.onboarding.step.skills',
      execute: async () => {
        await window.electronAPI?.sop?.getStats();
      },
      icon: (
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
        </svg>
      ),
    },
    {
      id: 'preset',
      labelKey: 'page.onboarding.step.preset',
      execute: async () => {
        if (!presetConfirmed) {
          await new Promise<void>((resolve) => {
            const check = setInterval(() => {
              if (presetConfirmed) {
                clearInterval(check);
                resolve();
              }
            }, 100);
          });
        }
      },
      icon: (
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="3" y="3" width="7" height="7" />
          <rect x="14" y="3" width="7" height="7" />
          <rect x="14" y="14" width="7" height="7" />
          <rect x="3" y="14" width="7" height="7" />
        </svg>
      ),
    },
    {
      id: 'ready',
      labelKey: 'page.onboarding.step.ready',
      execute: async () => {
        await window.electronAPI?.engine?.runPipeline(projectPath, {
          sop: true,
          presetName: selectedPreset || undefined,
        });
      },
      icon: (
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
          <polyline points="22 4 12 14.01 9 11.01" />
        </svg>
      ),
    },
  ];
}

function runStep(step: Step, onDone: () => void): void {
  step.execute().then(onDone).catch(onDone);
}

function runCurrentStep(
  steps: Step[],
  index: number,
  presetConfirmed: boolean,
  profileDetected: boolean,
  profileConfirmed: boolean,
  onDone: () => void,
): void {
  const step = steps[index];
  if (step.id === 'preset' && !presetConfirmed) {
    return;
  }
  if (step.id === 'confirm' && profileDetected && !profileConfirmed) {
    return;
  }
  runStep(step, onDone);
}

const ONBOARDING_PRESETS = [
  { id: 'nestjs-backend', label: 'NestJS 后端模板', desc: 'Node.js / TypeScript', icon: '🔧' },
  { id: 'frontend-standard', label: '前端标准模板', desc: 'React / Vue / TypeScript', icon: '🎨' },
  { id: 'general-purpose', label: '通用配置模板', desc: '所有项目类型', icon: '⚙️' },
];

function useStepAdvance(
  steps: Step[],
  presetConfirmed: boolean,
  profileDetected: boolean,
  profileConfirmed: boolean,
  onComplete: () => void,
) {
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [completedSteps, setCompletedSteps] = useState<Set<number>>(new Set());

  useEffect(() => {
    if (currentStepIndex >= steps.length) {
      const timer = setTimeout(onComplete, 500);
      return () => clearTimeout(timer);
    }
    runCurrentStep(
      steps,
      currentStepIndex,
      presetConfirmed,
      profileDetected,
      profileConfirmed,
      () => {
        setCompletedSteps((prev) => new Set(prev).add(currentStepIndex));
        setCurrentStepIndex((prev) => prev + 1);
      },
    );
  }, [
    currentStepIndex,
    steps.length,
    onComplete,
    presetConfirmed,
    profileDetected,
    profileConfirmed,
  ]);

  return { currentStepIndex, completedSteps };
}

function OnboardingLogo({ t }: { t: (key: string) => string }) {
  return (
    <div
      className="absolute top-4 left-5 flex items-center gap-2"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      <ShieldLogo size={22} />
      <span className="text-white text-sm font-semibold tracking-wide">
        {t('page.welcome.brand')}
      </span>
    </div>
  );
}

function OnboardingShield({ projectName }: { projectName: string }) {
  return (
    <>
      <div className="relative mb-8" style={{ width: 160, height: 160 }}>
        <div
          className="absolute inset-0 rounded-full"
          style={{
            background:
              'radial-gradient(circle, rgb(var(--zh-brand) / 0.25) 0%, rgb(var(--zh-brand) / 0.05) 60%, transparent 80%)',
          }}
        />
        <div
          className="absolute inset-0 rounded-full"
          style={{
            border: '2px solid rgb(var(--zh-brand) / 0.3)',
            borderTop: '2px solid rgba(255,255,255,0.6)',
            animation: 'spin 2s linear infinite',
          }}
        />
        <div className="absolute inset-0 flex items-center justify-center">
          <ShieldLogo size={60} />
        </div>
      </div>
      <div
        className="text-white text-xl font-bold mb-2"
        style={{ textShadow: '0 2px 12px rgba(0,0,0,0.35)' }}
      >
        {projectName}
      </div>
    </>
  );
}

function OnboardingProgressBar({ progress }: { progress: number }) {
  return (
    <div
      className="w-64 h-1.5 rounded-full overflow-hidden mb-8"
      style={{ background: 'rgba(255,255,255,0.15)' }}
    >
      <div
        className="h-full rounded-full transition-all duration-500"
        style={{
          width: `${progress}%`,
          background: 'linear-gradient(90deg, rgb(var(--zh-brand)) 0%, rgba(255,255,255,0.9) 100%)',
          boxShadow: '0 0 10px rgba(255,255,255,0.5)',
        }}
      />
    </div>
  );
}

function OnboardingStepList({
  steps,
  completedSteps,
  currentStepIndex,
  t,
}: {
  steps: Step[];
  completedSteps: Set<number>;
  currentStepIndex: number;
  t: (key: string) => string;
}) {
  return (
    <div className="flex flex-col gap-3 w-72">
      {steps.map((step, index) => {
        const isCompleted = completedSteps.has(index);
        const isCurrent = index === currentStepIndex;

        return (
          <div
            key={step.id}
            className={`flex items-center gap-3 px-4 py-3 rounded-lg transition-all duration-300 ${
              isCurrent
                ? 'bg-white/15 border border-white/30'
                : isCompleted
                  ? 'bg-white/8 border border-white/15'
                  : 'bg-white/5 border border-white/10 opacity-40'
            }`}
          >
            <div
              className={`flex items-center justify-center w-8 h-8 rounded-full ${
                isCurrent
                  ? 'bg-white/20 text-white'
                  : isCompleted
                    ? 'bg-success-500/20 text-success-400'
                    : 'bg-white/10 text-white/50'
              }`}
            >
              {isCompleted ? (
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                step.icon
              )}
            </div>
            <span
              className={`text-sm font-medium ${
                isCurrent ? 'text-white' : isCompleted ? 'text-white/80' : 'text-white/50'
              }`}
            >
              {t(step.labelKey)}
            </span>
            {isCurrent && (
              <div className="ml-auto">
                <div
                  className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full"
                  style={{ animation: 'spin 1s linear infinite' }}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function OnboardingPresetSelector({
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
        <button
          type="button"
          onClick={onConfirm}
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
          确认选择
        </button>
      </div>
    </div>
  );
}

/** 画像确认面板行：标签 + 值（值缺失显示通用兜底文案） */
function ProfileConfirmRow({
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
function OnboardingProfileConfirm({
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
        <button
          type="button"
          onClick={onConfirm}
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
          {t('page.onboarding.profileConfirm.confirmBtn')}
        </button>
      </div>
    </div>
  );
}

/** 云端规则差量同步摘要（sync:resolveRules 结果，失败/离线时提示降级） */
function OnboardingRuleSyncSummary({
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

function OnboardingSteps({
  steps,
  completedSteps,
  currentStepIndex,
  t,
  showPreset,
  selectedPreset,
  onSelectPreset,
  onConfirmPreset,
  showConfirm,
  profileSummary,
  onConfirmProfile,
  ruleSyncSummary,
}: {
  steps: Step[];
  completedSteps: Set<number>;
  currentStepIndex: number;
  t: (key: string, params?: Record<string, unknown>) => string;
  showPreset: boolean;
  selectedPreset: string | null;
  onSelectPreset: (id: string) => void;
  onConfirmPreset: () => void;
  showConfirm: boolean;
  profileSummary: OnboardingProfileSummary | null;
  onConfirmProfile: () => void;
  ruleSyncSummary: RuleSyncSummary | null;
}) {
  return (
    <>
      <OnboardingStepList
        steps={steps}
        completedSteps={completedSteps}
        currentStepIndex={currentStepIndex}
        t={t}
      />
      {ruleSyncSummary && <OnboardingRuleSyncSummary summary={ruleSyncSummary} t={t} />}
      {showConfirm && profileSummary && (
        <OnboardingProfileConfirm summary={profileSummary} onConfirm={onConfirmProfile} t={t} />
      )}
      {showPreset && (
        <OnboardingPresetSelector
          presets={ONBOARDING_PRESETS}
          selectedPreset={selectedPreset}
          onSelect={onSelectPreset}
          onConfirm={onConfirmPreset}
        />
      )}
    </>
  );
}

function OnboardingCenter({
  projectName,
  progress,
  steps,
  completedSteps,
  currentStepIndex,
  t,
  showPreset,
  selectedPreset,
  onSelectPreset,
  onConfirmPreset,
  showConfirm,
  profileSummary,
  onConfirmProfile,
  ruleSyncSummary,
}: {
  projectName: string;
  progress: number;
  steps: Step[];
  completedSteps: Set<number>;
  currentStepIndex: number;
  t: (key: string, params?: Record<string, unknown>) => string;
  showPreset: boolean;
  selectedPreset: string | null;
  onSelectPreset: (id: string) => void;
  onConfirmPreset: () => void;
  showConfirm: boolean;
  profileSummary: OnboardingProfileSummary | null;
  onConfirmProfile: () => void;
  ruleSyncSummary: RuleSyncSummary | null;
}) {
  return (
    <div className="relative flex flex-col items-center">
      <OnboardingShield projectName={projectName} />
      <OnboardingProgressBar progress={progress} />
      <OnboardingSteps
        steps={steps}
        completedSteps={completedSteps}
        currentStepIndex={currentStepIndex}
        t={t}
        showPreset={showPreset}
        selectedPreset={selectedPreset}
        onSelectPreset={onSelectPreset}
        onConfirmPreset={onConfirmPreset}
        showConfirm={showConfirm}
        profileSummary={profileSummary}
        onConfirmProfile={onConfirmProfile}
        ruleSyncSummary={ruleSyncSummary}
      />
    </div>
  );
}

function OnboardingContent({
  t,
  projectName,
  steps,
  currentStepIndex,
  completedSteps,
  progress,
  selectedPreset,
  onSelectPreset,
  onConfirmPreset,
  showPreset,
  showConfirm,
  profileSummary,
  onConfirmProfile,
  ruleSyncSummary,
  onClose,
  intelligentEnabled = true,
}: {
  t: (key: string, params?: Record<string, unknown>) => string;
  projectName: string;
  steps: Step[];
  currentStepIndex: number;
  completedSteps: Set<number>;
  progress: number;
  selectedPreset: string | null;
  onSelectPreset: (id: string) => void;
  onConfirmPreset: () => void;
  showPreset: boolean;
  showConfirm: boolean;
  profileSummary: OnboardingProfileSummary | null;
  onConfirmProfile: () => void;
  ruleSyncSummary: RuleSyncSummary | null;
  onClose?: () => void;
  intelligentEnabled?: boolean;
}) {
  return (
    <div
      className="flex flex-col items-center justify-center h-full w-full relative"
      style={{
        background:
          'linear-gradient(180deg, rgb(var(--zh-brand-900)) 0%, rgb(var(--zh-brand-dark)) 20%, rgb(var(--zh-brand)) 50%, rgb(var(--zh-brand-700)) 80%, rgb(var(--zh-brand-600)) 100%)',
      }}
    >
      <OnboardingLogo t={t} />

      {/* 右上角：关闭诊断页面（不等待，稍后可从侧边栏项目画像入口重新打开） */}
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭诊断页面"
          className="absolute top-8 right-10 flex items-center justify-center w-9 h-9 rounded-full border-none cursor-pointer text-white/80 hover:text-white transition-all duration-200"
          style={{
            background: 'rgba(255,255,255,0.1)',
            border: '1px solid rgba(255,255,255,0.2)',
            WebkitAppRegion: 'no-drag',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'rgba(255,255,255,0.22)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'rgba(255,255,255,0.1)';
          }}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      )}

      {/* 智能引擎状态指示器 */}
      <div
        className="absolute top-8 right-24 flex items-center gap-2 pointer-events-none"
        style={{ opacity: 0.7 }}
      >
        <span
          className="w-2 h-2 rounded-full"
          style={{
            background: intelligentEnabled ? '#27c93f' : '#ef4444',
            boxShadow: `0 0 6px ${intelligentEnabled ? '#27c93f' : '#ef4444'}`,
          }}
        />
        <span className="text-sm text-white/80">智能引擎</span>
      </div>

      <OnboardingCenter
        projectName={projectName}
        progress={progress}
        steps={steps}
        completedSteps={completedSteps}
        currentStepIndex={currentStepIndex}
        t={t}
        showPreset={showPreset}
        selectedPreset={selectedPreset}
        onSelectPreset={onSelectPreset}
        onConfirmPreset={onConfirmPreset}
        showConfirm={showConfirm}
        profileSummary={profileSummary}
        onConfirmProfile={onConfirmProfile}
        ruleSyncSummary={ruleSyncSummary}
      />
      <div className="absolute bottom-6 text-white/40 text-xs">{t('page.onboarding.hint')}</div>
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

export function ProjectOnboardingPage({
  projectName,
  projectPath,
  onComplete,
  onClose,
  intelligentEnabled = true,
}: ProjectOnboardingPageProps) {
  const t = useT();
  const [selectedPreset, setSelectedPreset] = useState<string | null>(null);
  const [presetConfirmed, setPresetConfirmed] = useState(false);
  const [profileSummary, setProfileSummary] = useState<OnboardingProfileSummary | null>(null);
  const [profileConfirmed, setProfileConfirmed] = useState(false);
  const [ruleSyncSummary, setRuleSyncSummary] = useState<RuleSyncSummary | null>(null);
  const steps = buildSteps(
    projectPath,
    presetConfirmed,
    selectedPreset,
    profileSummary !== null,
    profileConfirmed,
    setProfileSummary,
    setRuleSyncSummary,
  );
  const { currentStepIndex, completedSteps } = useStepAdvance(
    steps,
    presetConfirmed,
    profileSummary !== null,
    profileConfirmed,
    onComplete,
  );

  return (
    <OnboardingContent
      t={t}
      projectName={projectName}
      steps={steps}
      currentStepIndex={currentStepIndex}
      completedSteps={completedSteps}
      progress={Math.min((currentStepIndex / steps.length) * 100, 100)}
      selectedPreset={selectedPreset}
      onSelectPreset={setSelectedPreset}
      onConfirmPreset={() => setPresetConfirmed(true)}
      showPreset={
        currentStepIndex < steps.length &&
        steps[currentStepIndex].id === 'preset' &&
        !presetConfirmed
      }
      showConfirm={
        currentStepIndex < steps.length &&
        steps[currentStepIndex].id === 'confirm' &&
        profileSummary !== null &&
        !profileConfirmed
      }
      profileSummary={profileSummary}
      onConfirmProfile={() => setProfileConfirmed(true)}
      ruleSyncSummary={ruleSyncSummary}
      onClose={onClose}
      intelligentEnabled={intelligentEnabled}
    />
  );
}
