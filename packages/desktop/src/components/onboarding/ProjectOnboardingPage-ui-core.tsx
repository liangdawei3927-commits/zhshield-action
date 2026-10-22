// 项目引导页核心 UI 组件
import { ShieldLogo } from '../ui/Icons';

export function OnboardingLogo({ t }: { t: (key: string) => string }) {
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

export function OnboardingShield({ projectName }: { projectName: string }) {
  return (
    <>
      <div className="relative mb-6" style={{ width: 128, height: 128 }}>
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
          <ShieldLogo size={44} />
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

export function OnboardingProgressBar({ progress }: { progress: number }) {
  return (
    <div
      className="w-64 h-1.5 rounded-full overflow-hidden mb-6"
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
