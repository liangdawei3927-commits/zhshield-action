import { useCallback, useState } from 'react';
import { dismissSecret, markSecretRotating, runSecrets, verifySecretRotated } from '../services/engineApi';
import type { SecretReportData } from '../types/electron';

export const SECRET_SEVERITY_CONFIG: Record<string, { color: string; bg: string; labelKey: string }> = {
  critical: { color: 'rgb(var(--zh-danger))', bg: 'rgb(var(--zh-danger) / 0.1)', labelKey: 'page.secrets.severity.critical' },
  high: { color: 'rgb(var(--zh-warning))', bg: 'rgb(var(--zh-warning) / 0.12)', labelKey: 'page.secrets.severity.high' },
  medium: { color: 'rgb(var(--zh-warning))', bg: 'rgb(var(--zh-warning) / 0.08)', labelKey: 'page.secrets.severity.medium' },
  low: { color: 'rgb(var(--zh-muted))', bg: 'rgb(var(--zh-muted) / 0.08)', labelKey: 'page.secrets.severity.low' },
};

export const SECRET_STATUS_CONFIG: Record<string, { color: string; bg: string; labelKey: string }> = {
  active: { color: 'rgb(var(--zh-warning))', bg: 'rgb(var(--zh-warning) / 0.12)', labelKey: 'page.secrets.status.active' },
  rotating: { color: 'rgb(var(--zh-info))', bg: 'rgb(var(--zh-info) / 0.1)', labelKey: 'page.secrets.status.rotating' },
  rotated: { color: 'rgb(var(--zh-success-700))', bg: 'rgb(var(--zh-success) / 0.08)', labelKey: 'page.secrets.status.rotated' },
  dismissed: { color: 'rgb(var(--zh-muted))', bg: 'rgb(var(--zh-muted) / 0.08)', labelKey: 'page.secrets.status.dismissed' },
};

export const SECRET_TYPE_LABEL: Record<string, string> = {
  'aws-access-key': 'page.secrets.type.awsAccessKey',
  'aws-secret-key': 'page.secrets.type.awsSecretKey',
  'github-token': 'page.secrets.type.githubToken',
  'gitlab-token': 'page.secrets.type.gitlabToken',
  'database-password': 'page.secrets.type.databasePassword',
  'redis-password': 'page.secrets.type.redisPassword',
  'private-key': 'page.secrets.type.privateKey',
  'stripe-key': 'page.secrets.type.stripeKey',
  'twilio-key': 'page.secrets.type.twilioKey',
  'jwt-token': 'page.secrets.type.jwtToken',
  'alibaba-cloud-access-key': 'page.secrets.type.alibabaCloudAccessKey',
  'tencent-cloud-secret-id': 'page.secrets.type.tencentCloudSecretId',
  'tencent-cloud-secret-key': 'page.secrets.type.tencentCloudSecretKey',
  'huawei-cloud-access-key': 'page.secrets.type.huaweiCloudAccessKey',
  'huawei-cloud-secret-key': 'page.secrets.type.huaweiCloudSecretKey',
  'google-cloud-service-account': 'page.secrets.type.googleCloudServiceAccount',
  'azure-storage-account-key': 'page.secrets.type.azureStorageAccountKey',
  'npm-token': 'page.secrets.type.npmToken',
  'pypi-token': 'page.secrets.type.pypiToken',
  'dockerhub-token': 'page.secrets.type.dockerhubToken',
  'slack-webhook-url': 'page.secrets.type.slackWebhookUrl',
  'discord-webhook-url': 'page.secrets.type.discordWebhookUrl',
  'telegram-bot-token': 'page.secrets.type.telegramBotToken',
  'generic-api-key': 'page.secrets.type.genericApiKey',
};

export const SECRET_DISMISS_REASON = 'user-dismissed';

function useSecretsRun(projectPath: string): {
  loading: boolean;
  report: SecretReportData | null;
  handleScan: () => Promise<void>;
  refresh: () => Promise<void>;
} {
  const [report, setReport] = useState<SecretReportData | null>(null);
  const [loading, setLoading] = useState(false);

  const handleScan = useCallback(async () => {
    setLoading(true);
    try {
      const result = await runSecrets(projectPath);
      setReport(result);
    } catch {
      setReport(null);
    } finally {
      setLoading(false);
    }
  }, [projectPath]);

  const refresh = useCallback(async () => {
    try {
      const result = await runSecrets(projectPath);
      setReport(result);
    } catch {
    }
  }, [projectPath]);

  return { loading, report, handleScan, refresh };
}

export function useSecretsPage(projectPath: string) {
  const { loading, report, handleScan, refresh } = useSecretsRun(projectPath);

  const handleMarkRotating = useCallback(
    async (secretId: string) => {
      try {
        await markSecretRotating(secretId);
      } finally {
        await refresh();
      }
    },
    [refresh],
  );

  const handleVerifyRotated = useCallback(
    async (secretId: string) => {
      try {
        await verifySecretRotated(secretId);
      } finally {
        await refresh();
      }
    },
    [refresh],
  );

  const handleDismiss = useCallback(
    async (secretId: string) => {
      try {
        await dismissSecret(secretId, SECRET_DISMISS_REASON);
      } finally {
        await refresh();
      }
    },
    [refresh],
  );

  return { loading, report, handleScan, handleMarkRotating, handleVerifyRotated, handleDismiss };
}
