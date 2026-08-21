import { useEffect, useState } from 'react';
import type { ProjectProfile } from './profile-parts';
import { StaleBadge, SectionCard, DataRow, ConfidenceBadge, SignalList, TargetCard, OverridesPanel } from './profile-parts';
import { useNotification } from '../contexts/NotificationContext';

interface ProfilePageProps {
  projectPath: string;
}

export function ProfilePage({ projectPath }: ProfilePageProps) {
  const [profile, setProfile] = useState<ProjectProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { preferences, setPreferences } = useNotification();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    window.electronAPI!.engine!.runProfile(projectPath)
      .then((result) => {
        if (!cancelled) {
          setProfile(result.profile as ProjectProfile);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      });

    return () => { cancelled = true; };
  }, [projectPath]);

  if (loading) {
    return (
      <div className="h-full w-full bg-zh-bg flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-zh-info mx-auto mb-3" />
          <p className="text-sm text-zh-muted">正在分析项目…</p>
        </div>
      </div>
    );
  }

  if (error || !profile) {
    return (
      <div className="h-full w-full bg-zh-bg flex items-center justify-center">
        <div className="text-center">
          <p className="text-sm text-red-600 mb-2">画像分析失败</p>
          <p className="text-xs text-zh-muted">{error ?? '未知错误'}</p>
        </div>
      </div>
    );
  }

  const collectedSignals = profile.targets.flatMap((t) => t.language.signals);

  return (
    <div className="h-full w-full bg-zh-bg overflow-auto">
      <div className="w-full px-8 py-10">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-bold text-zh-ink">项目画像</h1>
            {profile.stale && <StaleBadge />}
          </div>
          <div className="flex items-center gap-2 text-xs text-zh-muted">
            <span>检测于 {new Date(profile.detectedAt).toLocaleString()}</span>
            {profile.lastConfirmedAt && (
              <span>· 确认于 {new Date(profile.lastConfirmedAt).toLocaleString()}</span>
            )}
            <span className="font-mono bg-zh-panel px-2 py-0.5 rounded">v{profile.schemaVersion}</span>
          </div>
        </div>

        <SectionCard title="概览">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="text-center p-3 bg-zh-bg rounded-lg">
              <div className="text-[11px] text-zh-muted mb-1">架构形态</div>
              <div className="text-sm font-semibold text-zh-ink">{profile.architecture.value}</div>
              <ConfidenceBadge confidence={profile.architecture.confidence} />
            </div>
            <div className="text-center p-3 bg-zh-bg rounded-lg">
              <div className="text-[11px] text-zh-muted mb-1">目标数</div>
              <div className="text-sm font-semibold text-zh-ink">{profile.targets.length}</div>
            </div>
            <div className="text-center p-3 bg-zh-bg rounded-lg">
              <div className="text-[11px] text-zh-muted mb-1">运行环境</div>
              <div className="text-sm font-semibold text-zh-ink">{profile.environments.map((e) => e.value).join(', ')}</div>
            </div>
            <div className="text-center p-3 bg-zh-bg rounded-lg">
              <div className="text-[11px] text-zh-muted mb-1">信号总数</div>
              <div className="text-sm font-semibold text-zh-ink">{collectedSignals.length}</div>
            </div>
          </div>
        </SectionCard>

        <SectionCard title="目标列表">
          {profile.targets.map((target) => (
            <TargetCard key={target.id} target={target} />
          ))}
        </SectionCard>

        <SectionCard title="运行环境">
          <div className="space-y-1">
            {profile.environments.map((env, i) => (
              <DataRow
                key={i}
                label={env.value}
                value={<span className="font-mono">{env.confidence >= 0.9 ? '确认' : '候选'}</span>}
                badge={<ConfidenceBadge confidence={env.confidence} />}
              />
            ))}
          </div>
        </SectionCard>

        <SectionCard title="依赖摘要">
          <DataRow label="包管理器" value={profile.dependencies.packageManager ?? '未知'} />
          <DataRow label="锁文件" value={profile.dependencies.lockfilePath ?? '未检测'} />
          <DataRow
            label="直接依赖"
            value={<span className="text-[11px] font-mono">{profile.dependencies.direct.length} 个</span>}
          />
          {profile.dependencies.direct.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {profile.dependencies.direct.map((dep) => (
                <span key={dep.name} className="inline-flex items-center gap-1 px-2 py-0.5 bg-zh-bg rounded text-[11px] font-mono text-zh-ink">
                  {dep.name}
                  <span className="text-zh-muted">@{dep.version}</span>
                </span>
              ))}
            </div>
          )}
        </SectionCard>

        <SectionCard title="人工修正记录">
          <OverridesPanel overrides={profile.overrides} />
        </SectionCard>

        <SectionCard title="信号追溯">
          <SignalList signals={collectedSignals} />
        </SectionCard>

        <SectionCard title="通知设置">
          <div className="flex items-center justify-between py-2">
            <div>
              <div className="text-sm font-medium text-zh-ink">系统通知</div>
              <div className="text-xs text-zh-muted">门禁拦截和哨兵告警时发送系统通知</div>
            </div>
            <button
              type="button"
              onClick={() => setPreferences({ enabled: !preferences.enabled })}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                preferences.enabled ? 'bg-zh-info' : 'bg-zh-muted/40'
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                  preferences.enabled ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </div>
        </SectionCard>
      </div>
    </div>
  );
}
