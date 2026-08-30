import { useCallback, useState } from 'react';
import { Logger } from '@zh/kernel';
import { dismissSecret, markSecretRotating, runSecrets, verifySecretRotated } from '../services/engineApi';
import type { SecretReportData } from '../types/electron';

const logger = new Logger('secrets-logic');

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

async function scanSecrets(projectPath: string): Promise<SecretReportData | null> {
  try {
    return await runSecrets(projectPath);
  } catch {
    return null;
  }
}

async function refreshSecrets(projectPath: string): Promise<SecretReportData | null> {
  try {
    return await runSecrets(projectPath);
  } catch (err) {
    logger.error('密钥扫描刷新失败:', err);
    return null;
  }
}

async function runSecretAction(action: () => Promise<void>, refresh: () => Promise<void>): Promise<void> {
  try {
    await action();
  } finally {
    await refresh();
  }
}

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
    const result = await scanSecrets(projectPath);
    setReport(result);
    setLoading(false);
  }, [projectPath]);

  const refresh = useCallback(async () => {
    const result = await refreshSecrets(projectPath);
    if (result !== null) setReport(result);
  }, [projectPath]);

  return { loading, report, handleScan, refresh };
}

function useSecretActions(refresh: () => Promise<void>): {
  handleMarkRotating: (secretId: string) => Promise<void>;
  handleVerifyRotated: (secretId: string) => Promise<void>;
  handleDismiss: (secretId: string) => Promise<void>;
} {
  const handleMarkRotating = useCallback(
    async (secretId: string) => {
      await runSecretAction(() => markSecretRotating(secretId), refresh);
    },
    [refresh],
  );

  const handleVerifyRotated = useCallback(
    async (secretId: string) => {
      await runSecretAction(() => verifySecretRotated(secretId), refresh);
    },
    [refresh],
  );

  const handleDismiss = useCallback(
    async (secretId: string) => {
      await runSecretAction(() => dismissSecret(secretId, SECRET_DISMISS_REASON), refresh);
    },
    [refresh],
  );

  return { handleMarkRotating, handleVerifyRotated, handleDismiss };
}

export function useSecretsPage(projectPath: string) {
  const { loading, report, handleScan, refresh } = useSecretsRun(projectPath);
  const { handleMarkRotating, handleVerifyRotated, handleDismiss } = useSecretActions(refresh);
  return { loading, report, handleScan, handleMarkRotating, handleVerifyRotated, handleDismiss };
}
