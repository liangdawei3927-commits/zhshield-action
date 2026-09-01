import {
  useMacOSTrafficLightInset,
  TRAFFIC_LIGHT_OFFSET,
} from '../hooks/useMacOSTrafficLightInset';
import { ShieldLogo } from '../components/ui/Icons';
import { PrimaryButton } from '../components/ui/PrimaryButton';
import { useT } from '../i18n';

interface WelcomePageProps {
  onAddProject: () => void;
}

export function WelcomePage({ onAddProject }: WelcomePageProps) {
  const maximized = useMacOSTrafficLightInset();

  return (
    <div
      className="flex flex-col items-center justify-center h-full w-full relative"
      style={{
        background:
          'linear-gradient(180deg, rgb(var(--zh-brand-900)) 0%, rgb(var(--zh-brand-dark)) 30%, rgb(var(--zh-brand-hover)) 60%, rgb(var(--zh-brand-600)) 100%)',
      }}
    >
      <WelcomeCorners maximized={maximized} />
      <WelcomeHero />
      <WelcomeSlogan />
      <AddProjectButton onAddProject={onAddProject} />
      <WelcomeStats />
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

/** 左上角 Logo / 右上角引擎状态 / 右下角云大脑状态 */
function WelcomeCorners({ maximized }: { maximized: boolean }) {
  const t = useT();
  return (
    <>
      {/* 左上角：Logo + 智汇码盾 */}
      <div
        className="absolute top-4 flex items-center gap-2"
        style={{
          left: maximized ? 20 : TRAFFIC_LIGHT_OFFSET,
          WebkitAppRegion: 'drag',
        }}
      >
        <ShieldLogo size={22} />
        <span className="text-white text-sm font-semibold tracking-wide">
          {t('page.welcome.brand')}
        </span>
      </div>

      {/* 右上角：引擎状态 */}
      <div
        className="absolute top-4 right-5 flex items-center gap-2 px-3 py-1.5 rounded-full"
        style={{
          background: 'rgb(var(--zh-brand) / 0.12)',
          border: '1px solid rgb(var(--zh-brand) / 0.25)',
        }}
      >
        <span
          className="w-2 h-2 rounded-full"
          style={{
            background: 'rgb(var(--zh-brand))',
            boxShadow: '0 0 6px rgb(var(--zh-brand) / 0.6)',
          }}
        />
        <span className="text-xs font-medium" style={{ color: 'rgba(255,255,255,0.7)' }}>
          {t('page.welcome.engineOn')}
        </span>
      </div>

      {/* 右下角 */}
      <div
        className="absolute bottom-4 right-5 flex items-center gap-2"
        style={{ color: 'rgba(255,255,255,0.35)' }}
      >
        <span className="text-xs flex items-center gap-1.5">
          <span
            className="w-1.5 h-1.5 rounded-full"
            style={{
              background: 'rgb(var(--zh-brand))',
              boxShadow: '0 0 4px rgb(var(--zh-brand) / 0.5)',
            }}
          />
          {t('page.welcome.cloudOn')}
        </span>
      </div>
    </>
  );
}

/** 中央大盾牌 + 光环 */
function WelcomeHero() {
  return (
    <div
      className="relative flex items-center justify-center mb-8"
      style={{ width: 200, height: 200 }}
    >
      <div
        className="absolute rounded-full"
        style={{
          width: 200,
          height: 200,
          background:
            'radial-gradient(circle, rgb(var(--zh-brand) / 0.25) 0%, rgb(var(--zh-brand) / 0.05) 60%, transparent 80%)',
        }}
      />
      <div
        className="absolute rounded-full"
        style={{
          width: 180,
          height: 180,
          border: '2px solid rgb(var(--zh-brand) / 0.3)',
          borderTop: '2px solid rgba(255,255,255,0.6)',
          animation: 'spin 6s linear infinite',
        }}
      />
      <div
        className="absolute rounded-full"
        style={{ width: 140, height: 140, border: '1px solid rgb(var(--zh-brand) / 0.2)' }}
      />
      <div className="relative z-10">
        <ShieldLogo size={80} />
      </div>
    </div>
  );
}

function WelcomeSlogan() {
  const t = useT();
  const axes = [
    { label: t('page.welcome.axis.security'), color: 'rgb(var(--zh-success))' },
    { label: t('page.welcome.axis.governance'), color: 'rgb(var(--zh-brand))' },
    { label: t('page.welcome.axis.ops'), color: 'rgb(var(--zh-warning))' },
  ];

  return (
    <div className="flex flex-col items-center mb-10">
      <div
        className="text-[28px] font-bold text-white tracking-widest"
        style={{ textShadow: '0 2px 12px rgba(0,0,0,0.35)' }}
      >
        {t('page.welcome.sloganTitle')}
      </div>
      <div className="flex items-center gap-3 mt-5">
        {axes.map((item) => (
          <span
            key={item.label}
            className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-medium"
            style={{
              background: 'rgba(255,255,255,0.06)',
              border: '1px solid rgba(255,255,255,0.14)',
              color: 'rgba(255,255,255,0.8)',
            }}
          >
            <span
              className="w-1.5 h-1.5 rounded-full"
              style={{ background: item.color, boxShadow: `0 0 6px ${item.color}` }}
            />
            {item.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/** 添加项目按钮 — 直接弹出原生文件夹选择器 */
function AddProjectButton({ onAddProject }: { onAddProject: () => void }) {
  const t = useT();
  return (
    <PrimaryButton onClick={onAddProject} className="hover:scale-105">
      {t('page.welcome.addProject')}
    </PrimaryButton>
  );
}

/** 底部统计 */
function WelcomeStats() {
  const t = useT();
  const stats = [
    { label: t('page.welcome.stat.protectedProjects'), value: '0' },
    {
      label: t('page.welcome.stat.totalBlocked'),
      value: t('page.welcome.stat.times', { count: 0 }),
    },
    { label: t('page.welcome.stat.healthScore'), value: '--' },
  ];

  return (
    <div className="flex gap-12 mt-10">
      {stats.map((item) => (
        <div key={item.label} className="text-center">
          <div className="text-2xl font-bold text-white mb-1">{item.value}</div>
          <div className="text-xs" style={{ color: 'rgba(255,255,255,0.35)' }}>
            {item.label}
          </div>
        </div>
      ))}
    </div>
  );
}
