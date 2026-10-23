import { useEffect, useState } from 'react';
import type { ProjectProfile } from './profile-parts';
import {
  StaleBadge,
  SectionCard,
  DataRow,
  ConfidenceBadge,
  SignalList,
  TargetCard,
  OverridesPanel,
} from './profile-parts';
import { PageGlyph } from '../components/business/page-glyph';
import { useNotification } from '../contexts/NotificationContext';
import { useT } from '../i18n';

interface ProfilePageProps {
  projectPath: string;
}

function ProfileLoadingView() {
  const t = useT();
  return (
    <div className="h-full w-full bg-zh-bg flex items-center justify-center">
      <div className="text-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-zh-info mx-auto mb-3" />
        <p className="text-sm text-zh-muted">{t('page.profile.detecting')}</p>
      </div>
    </div>
  );
}

function ProfileErrorView({ error }: { error: string | null }) {
  const t = useT();
  return (
    <div className="h-full w-full bg-zh-bg flex items-center justify-center">
      <div className="text-center">
        <p className="text-sm text-danger-600 mb-2">{t('page.profile.error.title')}</p>
        <p className="text-xs text-zh-muted">{error ?? t('page.profile.error.unknown')}</p>
      </div>
    </div>
  );
}

function ProfileHeader({ profile }: { profile: ProjectProfile }) {
  const t = useT();
  return (
    <div className="flex items-center gap-4 mb-6">
      <PageGlyph bg="brand" stroke="brand">
        <circle cx="12" cy="8" r="4" />
        <path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1" />
      </PageGlyph>
      <div className="min-w-0">
        <h1 className="text-2xl font-bold text-zh-ink flex items-center gap-2">
          {t('page.profile.title')}
          {profile.stale && <StaleBadge />}
        </h1>
        <p className="text-sm text-zh-muted mt-1">
          {t('page.profile.detectedAt', { time: new Date(profile.detectedAt).toLocaleString() })}
          {profile.lastConfirmedAt && (
            <span>
              {' · '}
              {t('page.profile.confirmedAt', {
                time: new Date(profile.lastConfirmedAt).toLocaleString(),
              })}
            </span>
          )}
          <span className="font-mono bg-zh-panel px-2 py-0.5 rounded ml-2">
            v{profile.schemaVersion}
          </span>
        </p>
      </div>
    </div>
  );
}

function ProfileOverview({
  profile,
  signalCount,
}: {
  profile: ProjectProfile;
  signalCount: number;
}) {
  const t = useT();
  return (
    <SectionCard title={t('page.profile.section.overview')}>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="text-center p-3 bg-zh-bg rounded-lg">
          <div className="text-[11px] text-zh-muted mb-1">
            {t('page.profile.overview.architecture')}
          </div>
          <div className="text-sm font-semibold text-zh-ink">{profile.architecture.value}</div>
          <ConfidenceBadge confidence={profile.architecture.confidence} />
        </div>
        <div className="text-center p-3 bg-zh-bg rounded-lg">
          <div className="text-[11px] text-zh-muted mb-1">{t('page.profile.overview.targetCount')}</div>
          <div className="text-sm font-semibold text-zh-ink">{profile.targets.length}</div>
        </div>
        <div className="text-center p-3 bg-zh-bg rounded-lg">
          <div className="text-[11px] text-zh-muted mb-1">
            {t('page.profile.overview.environments')}
          </div>
          <div className="text-sm font-semibold text-zh-ink">
            {profile.environments.map((e) => e.value).join(', ')}
          </div>
        </div>
        <div className="text-center p-3 bg-zh-bg rounded-lg">
          <div className="text-[11px] text-zh-muted mb-1">
            {t('page.profile.overview.signalCount')}
          </div>
          <div className="text-sm font-semibold text-zh-ink">{signalCount}</div>
        </div>
      </div>
    </SectionCard>
  );
}

function ProfileTargets({ profile }: { profile: ProjectProfile }) {
  const t = useT();
  return (
    <SectionCard title={t('page.profile.section.targets')}>
      {profile.targets.map((target) => (
        <TargetCard key={target.id} target={target} />
      ))}
    </SectionCard>
  );
}

function ProfileEnvironments({ profile }: { profile: ProjectProfile }) {
  const t = useT();
  return (
    <SectionCard title={t('page.profile.section.environments')}>
      <div className="space-y-1">
        {profile.environments.map((env, i) => (
          <DataRow
            key={i}
            label={env.value}
            value={
              <span className="font-mono">
                {env.confidence >= 0.9
                  ? t('page.profile.env.confirmed')
                  : t('page.profile.env.candidate')}
              </span>
            }
            badge={<ConfidenceBadge confidence={env.confidence} />}
          />
        ))}
      </div>
    </SectionCard>
  );
}

function ProfileDependencies({ profile }: { profile: ProjectProfile }) {
  const t = useT();
  return (
    <SectionCard title={t('page.profile.section.dependencies')}>
      <DataRow
        label={t('page.profile.deps.packageManager')}
        value={profile.dependencies.packageManager ?? t('page.profile.deps.unknown')}
      />
      <DataRow
        label={t('page.profile.deps.lockfile')}
        value={profile.dependencies.lockfilePath ?? t('page.profile.deps.notDetected')}
      />
      <DataRow
        label={t('page.profile.deps.direct')}
        value={
          <span className="text-[11px] font-mono">
            {t('page.profile.deps.count', { count: profile.dependencies.direct.length })}
          </span>
        }
      />
      {profile.dependencies.direct.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {profile.dependencies.direct.map((dep) => (
            <span
              key={dep.name}
              className="inline-flex items-center gap-1 px-2 py-0.5 bg-zh-bg rounded text-[11px] font-mono text-zh-ink"
            >
              {dep.name}
              <span className="text-zh-muted">@{dep.version}</span>
            </span>
          ))}
        </div>
      )}
    </SectionCard>
  );
}

function ProfileOverrides({ profile }: { profile: ProjectProfile }) {
  const t = useT();
  return (
    <SectionCard title={t('page.profile.section.overrides')}>
      <OverridesPanel overrides={profile.overrides} />
    </SectionCard>
  );
}

function ProfileSignals({
  signals,
}: {
  signals: ProjectProfile['targets'][number]['language']['signals'];
}) {
  const t = useT();
  return (
    <SectionCard title={t('page.profile.section.signals')}>
      <SignalList signals={signals} />
    </SectionCard>
  );
}

function ProfileNotifications({ enabled, onToggle }: { enabled: boolean; onToggle: () => void }) {
  const t = useT();
  return (
    <SectionCard title={t('page.profile.section.notifications')}>
      <div className="flex items-center justify-between py-2">
        <div>
          <div className="text-sm font-medium text-zh-ink">{t('page.profile.notify.title')}</div>
          <div className="text-xs text-zh-muted">{t('page.profile.notify.desc')}</div>
        </div>
        <button
          type="button"
          onClick={onToggle}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
            enabled ? 'bg-zh-info' : 'bg-zh-muted/40'
          }`}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
              enabled ? 'translate-x-6' : 'translate-x-1'
            }`}
          />
        </button>
      </div>
    </SectionCard>
  );
}

function ProfileContent({
  profile,
  preferences,
  setPreferences,
}: {
  profile: ProjectProfile;
  preferences: { enabled: boolean };
  setPreferences: (p: { enabled: boolean }) => void;
}) {
  const collectedSignals = profile.targets.flatMap((t) => t.language.signals);

  return (
    <div className="h-full w-full bg-zh-bg overflow-auto">
      <div className="w-full px-8 py-10">
        <ProfileHeader profile={profile} />
        <ProfileOverview profile={profile} signalCount={collectedSignals.length} />
        <ProfileTargets profile={profile} />
        <ProfileEnvironments profile={profile} />
        <ProfileDependencies profile={profile} />
        <ProfileOverrides profile={profile} />
        <ProfileSignals signals={collectedSignals} />
        <ProfileNotifications
          enabled={preferences.enabled}
          onToggle={() => setPreferences({ enabled: !preferences.enabled })}
        />
      </div>
    </div>
  );
}

function fetchProfile(
  projectPath: string,
  handlers: { onSuccess: (p: ProjectProfile) => void; onError: (msg: string) => void },
): void {
  const api = window.electronAPI;
  if (api === undefined) {
    handlers.onError('Electron API 不可用');
    return;
  }
  api.engine
    .runProfile(projectPath)
    .then((result) => handlers.onSuccess(result.profile as ProjectProfile))
    .catch((err: unknown) => handlers.onError(err instanceof Error ? err.message : String(err)));
}

function useProfileData(projectPath: string) {
  const [profile, setProfile] = useState<ProjectProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchProfile(projectPath, {
      onSuccess: (p) => {
        if (!cancelled) {
          setProfile(p);
          setLoading(false);
        }
      },
      onError: (msg) => {
        if (!cancelled) {
          setError(msg);
          setLoading(false);
        }
      },
    });
    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  return { profile, loading, error };
}

export function ProfilePage({ projectPath }: ProfilePageProps) {
  const { profile, loading, error } = useProfileData(projectPath);
  const { preferences, setPreferences } = useNotification();

  if (loading) {
    return <ProfileLoadingView />;
  }

  if (error || !profile) {
    return <ProfileErrorView error={error} />;
  }

  return (
    <ProfileContent profile={profile} preferences={preferences} setPreferences={setPreferences} />
  );
}
