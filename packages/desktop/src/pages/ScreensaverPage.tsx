import { useEffect, useState } from 'react';
import { ShieldLogo } from '../components/ui/Icons';
import { useMacOSTrafficLightInset, TRAFFIC_LIGHT_OFFSET } from '../hooks/useMacOSTrafficLightInset';

interface ScreensaverPageProps {
  onDismiss: () => void;
}

function ScreensaverBackground() {
  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none" aria-hidden="true">
      <div
        className="absolute -top-1/4 -left-1/4 w-1/2 h-1/2 rounded-full opacity-20"
        style={{
          background: 'radial-gradient(circle, rgb(var(--zh-brand-300)) 0%, transparent 70%)',
          animation: 'pulse 8s ease-in-out infinite',
        }}
      />
      <div
        className="absolute -bottom-1/4 -right-1/4 w-1/2 h-1/2 rounded-full opacity-15"
        style={{
          background: 'radial-gradient(circle, rgb(var(--zh-brand-200)) 0%, transparent 70%)',
          animation: 'pulse 10s ease-in-out infinite 2s',
        }}
      />
    </div>
  );
}

function ScreensaverHeader({ visible, maximized }: { visible: boolean; maximized: boolean }) {
  return (
    <>
      <div
        className="absolute top-0 left-0 flex items-center gap-2 pointer-events-none transition-all duration-700 ease-out"
        style={{
          height: 'var(--zh-header-title-h)',
          paddingLeft: maximized ? 16 : TRAFFIC_LIGHT_OFFSET,
          color: 'rgb(var(--zh-text-on-brand))',
          opacity: visible ? 0.8 : 0,
          transitionDelay: '200ms',
        }}
      >
        <ShieldLogo size={18} />
        <span style={{ fontSize: 'var(--zh-font-md)', fontWeight: 600, letterSpacing: 0.5 }}>智汇码盾</span>
      </div>

      <div
        className="absolute top-8 right-10 flex items-center gap-2 pointer-events-none transition-all duration-700 ease-out"
        style={{ opacity: visible ? 0.7 : 0, transitionDelay: '400ms' }}
      >
        <span
          className="w-2 h-2 rounded-full"
          style={{
            background: '#27c93f',
            boxShadow: '0 0 6px #27c93f',
          }}
        />
        <span className="text-sm text-white/80">智能引擎已开启</span>
      </div>
    </>
  );
}

function ScreensaverCenterLogo({ visible }: { visible: boolean }) {
  return (
    <div
      className="flex flex-col items-center gap-3 transition-all duration-1000 ease-out"
      style={{
        opacity: visible ? 1 : 0,
        transform: visible ? 'translateY(0)' : 'translateY(30px)',
      }}
    >
      <div
        className="w-24 h-24 flex items-center justify-center rounded-2xl mb-3"
        style={{
          background: 'rgba(255, 255, 255, 0.15)',
          backdropFilter: 'blur(10px)',
        }}
      >
        <ShieldLogo size={56} />
      </div>

      <h1
        className="text-5xl font-bold tracking-wider text-white"
        style={{ textShadow: '0 2px 20px rgba(0, 0, 0, 0.3)' }}
      >
        智汇码盾
      </h1>

      <div
        className="w-24 h-0.5 mt-2"
        style={{
          background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.6), transparent)',
        }}
      />
    </div>
  );
}

function ScreensaverCenterFeatures({ visible }: { visible: boolean }) {
  return (
    <div className="flex items-center gap-6 mt-4">
      {['安全', '治理', '运维'].map((item, index) => (
        <div
          key={item}
          className="flex items-center gap-2 transition-all duration-700 ease-out"
          style={{
            opacity: visible ? 1 : 0,
            transform: visible ? 'translateY(0)' : 'translateY(20px)',
            transitionDelay: `${400 + index * 150}ms`,
          }}
        >
          {index > 0 && <span className="text-white/30 text-lg mr-4">·</span>}
          <span className="text-xl text-white/90 font-medium tracking-wide">{item}</span>
        </div>
      ))}
    </div>
  );
}

function ScreensaverCenterBottom({ visible }: { visible: boolean }) {
  return (
    <>
      <p
        className="text-lg text-white/70 mt-2 transition-all duration-700 ease-out"
        style={{
          opacity: visible ? 1 : 0,
          transform: visible ? 'translateY(0)' : 'translateY(20px)',
          transitionDelay: '800ms',
        }}
      >
        你的项目智能卫士
      </p>

      <div
        className="flex flex-col items-center gap-3 mt-6 transition-all duration-700 ease-out"
        style={{
          opacity: visible ? 1 : 0,
          transform: visible ? 'translateY(0)' : 'translateY(20px)',
          transitionDelay: '1000ms',
        }}
      >
        <div
          className="px-6 py-3 rounded-full text-base font-medium text-white/95"
          style={{
            background: 'rgba(255, 255, 255, 0.12)',
            backdropFilter: 'blur(10px)',
            border: '1px solid rgba(255, 255, 255, 0.15)',
          }}
        >
          0 Token 为你的项目全天候保驾护航
        </div>
      </div>

      <p
        className="text-sm text-white/40 mt-12 transition-all duration-700 ease-out"
        style={{ opacity: visible ? 1 : 0, transitionDelay: '1400ms' }}
      >
        隐私保护中 · 点击任意位置进入系统
      </p>
    </>
  );
}

function ScreensaverCenter({ visible }: { visible: boolean }) {
  return (
    <div className="relative z-10 flex-1 flex flex-col items-center justify-center gap-8 pointer-events-none">
      <ScreensaverCenterLogo visible={visible} />
      <ScreensaverCenterFeatures visible={visible} />
      <ScreensaverCenterBottom visible={visible} />
    </div>
  );
}

function ScreensaverFooter({ visible }: { visible: boolean }) {
  return (
    <div
      className="absolute bottom-8 left-10 flex items-center gap-2 pointer-events-none transition-all duration-700 ease-out"
      style={{ opacity: visible ? 0.6 : 0, transitionDelay: '600ms' }}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
        <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
        <path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4" />
      </svg>
      <span className="text-sm text-white/70">智汇大脑</span>
    </div>
  );
}

export function ScreensaverPage({ onDismiss }: ScreensaverPageProps) {
  const [visible, setVisible] = useState(false);
  const maximized = useMacOSTrafficLightInset();

  useEffect(() => {
    const timer = setTimeout(setVisible, 50, true);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col cursor-pointer select-none"
      style={{
        background: 'linear-gradient(135deg, rgb(var(--zh-brand-900)) 0%, rgb(var(--zh-brand-700)) 50%, rgb(var(--zh-brand-500)) 100%)',
      }}
      onClick={onDismiss}
      onKeyDown={onDismiss}
      role="button"
      tabIndex={0}
    >
      <ScreensaverBackground />
      <ScreensaverHeader visible={visible} maximized={maximized} />
      <ScreensaverCenter visible={visible} />
      <ScreensaverFooter visible={visible} />

      <style>{`
        @keyframes pulse {
          0%, 100% { transform: scale(1); opacity: 0.2; }
          50% { transform: scale(1.1); opacity: 0.3; }
        }
      `}</style>
    </div>
  );
}
