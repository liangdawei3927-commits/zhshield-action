// 项目引导页步骤 UI 组件
import type { Step } from './ProjectOnboardingPage-types';

export function OnboardingStepList({
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
    <div className="flex flex-col gap-2 w-80">
      {steps.map((step, index) => {
        const isCompleted = completedSteps.has(index);
        const isCurrent = index === currentStepIndex;

        return (
          <div
            key={step.id}
            className={`flex items-center gap-3 px-4 py-2.5 rounded-lg transition-all duration-300 ${
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
