// @zh/security secrets — 密钥全生命周期（附 C：发现→定位→评估→轮换→复核 5 步闭环）
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  CommandRunner,
  SecretFinding,
  SecretPersistState,
  SecretScanReport,
  SecretSeverity,
  SecretStateRecord,
  SecretStatus,
  SecretType,
} from './types';

const execFileAsync = promisify(execFile);

const SCHEME_RE = /^[a-z]+:\/\//i;
const USER_RE = /^[^@]+@/;
const HOST_SPLIT_RE = /[:/]/;

/** gitleaks RuleID → 归一化 SecretType（未知规则 → generic-api-key） */
const RULE_TO_TYPE: Record<string, SecretType> = {
  'aws-access-token': 'aws-access-key',
  'aws-secret-key': 'aws-secret-key',
  'github-pat': 'github-token',
  'github-oauth': 'github-token',
  'github-app-token': 'github-token',
  'github-fine-grained-pat': 'github-token',
  'gitlab-pat': 'gitlab-token',
  'gitlab-ptt': 'gitlab-token',
  'gitlab-rrt': 'gitlab-token',
  'gitlab-trigger-token': 'gitlab-token',
  'postgresql-url': 'database-password',
  'mysql-url': 'database-password',
  'mongodb-url': 'database-password',
  'redis-url': 'redis-password',
  'private-key': 'private-key',
  'stripe-access-token': 'stripe-key',
  'twilio-api-key': 'twilio-key',
  'jwt-token': 'jwt-token',
  'alibaba-access-key': 'alibaba-cloud-access-key',
  'tencent-secret-id': 'tencent-cloud-secret-id',
  'tencent-secret-key': 'tencent-cloud-secret-key',
  'huawei-access-key': 'huawei-cloud-access-key',
  'huawei-secret-key': 'huawei-cloud-secret-key',
  'gcp-service-account': 'google-cloud-service-account',
  'azure-storage-key': 'azure-storage-account-key',
  'npm-token': 'npm-token',
  'pypi-token': 'pypi-token',
  'dockerhub-token': 'dockerhub-token',
  'slack-webhook': 'slack-webhook-url',
  'discord-webhook': 'discord-webhook-url',
  'telegram-bot-token': 'telegram-bot-token',
};

/** 云凭据类型（附 C.4：critical 判定「AWS/云 key」） */
const CLOUD_CREDENTIAL_TYPES: ReadonlySet<SecretType> = new Set<SecretType>([
  'aws-access-key',
  'aws-secret-key',
  'stripe-key',
  'twilio-key',
]);

/** 公开代码托管 host（remotePublic 判定；边界 2：仅本地 remote 配置，UI 标注不确定性） */
const PUBLIC_HOSTS: ReadonlySet<string> = new Set<string>([
  'github.com',
  'gitlab.com',
  'bitbucket.org',
  'gitee.com',
  'codeberg.org',
]);

/** 状态优先级：critical → high → medium → low（附 C.4） */
const SEVERITY_ORDER: Record<SecretSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/** 值 → sha256 确定性标识（全文不落盘） */
export function hashSecret(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** 脱敏：仅显示前 4 + 后 4 位（不足 8 位全脱敏） */
export function maskSecret(value: string): string {
  if (value.length <= 8) return '****';
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

/** gitleaks RuleID → SecretType（未知规则兜底 generic-api-key） */
export function mapRuleToType(ruleId: string): SecretType {
  return RULE_TO_TYPE[ruleId] ?? 'generic-api-key';
}

/** 附 C.4 严重度矩阵：critical=活跃+云凭据+已推远程 / high=活跃+已推公共远程 / medium=活跃(本地|私有远程)或历史+云凭据 / low=历史遗留无引用 */
export function classifySeverity(params: {
  stillReferenced: boolean;
  type: SecretType;
  pushedToRemote: boolean;
  remotePublic: boolean;
}): SecretSeverity {
  const { stillReferenced, type, pushedToRemote, remotePublic } = params;
  const cloud = CLOUD_CREDENTIAL_TYPES.has(type);
  if (stillReferenced && cloud && pushedToRemote) return 'critical';
  if (stillReferenced && pushedToRemote && remotePublic) return 'high';
  if (stillReferenced) return 'medium';
  if (cloud) return 'medium';
  return 'low';
}

/** 排序：critical→high→medium→low；同级 stillReferenced 优先（附 C.4） */
export function sortFindings(findings: SecretFinding[]): SecretFinding[] {
  return findings.toSorted((a, b) => {
    const sev = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (sev !== 0) return sev;
    return Number(b.stillReferenced) - Number(a.stillReferenced);
  });
}

/** 解析 git remote URL → host（ssh/https/file 均支持；解析失败返回空） */
export function parseRemoteHost(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return '';
  const withoutScheme = trimmed.replace(SCHEME_RE, '');
  const withoutUser = withoutScheme.replace(USER_RE, '');
  const host = withoutUser.split(HOST_SPLIT_RE)[0];
  return host || '';
}

/** remote URL 是否为公开托管形态（边界 2：仅形态判断，不声称已被爬取） */
export function isPublicRemoteUrl(url: string): boolean {
  const host = parseRemoteHost(url);
  if (!host) return false;
  return PUBLIC_HOSTS.has(host) || Array.from(PUBLIC_HOSTS, (h) => h).some((h) => host.endsWith(`.${h}`));
}

/** 默认命令执行器：gitleaks 检出密钥时退出码非 0 但 stdout 含有效 JSON，需保留 stdout */
const defaultRunner: CommandRunner = {
  async run(command, args, opts) {
    try {
      const { stdout } = await execFileAsync(command, args, {
        cwd: opts?.cwd,
        timeout: opts?.timeout ?? 60000,
        maxBuffer: opts?.maxBuffer ?? 16 * 1024 * 1024,
      });
      return { stdout };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      if (e.stdout) return { stdout: e.stdout };
      throw new Error(e.stderr || e.message || `command failed: ${command} ${args.join(' ')}`);
    }
  },
};

/** 状态存储抽象（持久化断点 + 状态机；不存明文） */
export interface SecretStore {
  load(): Promise<SecretPersistState>;
  save(state: SecretPersistState): Promise<void>;
}

/** 内存存储（默认，测试友好） */
export class InMemorySecretStore implements SecretStore {
  private state: SecretPersistState = { lastScannedCommit: '', secrets: {} };

  async load(): Promise<SecretPersistState> {
    return {
      lastScannedCommit: this.state.lastScannedCommit,
      secrets: { ...this.state.secrets },
    };
  }

  async save(state: SecretPersistState): Promise<void> {
    this.state = { lastScannedCommit: state.lastScannedCommit, secrets: { ...state.secrets } };
  }
}

/** 文件存储（.zhshield/secrets-state.json；只存 hash/状态/原因，不落明文） */
export class FileSecretStore implements SecretStore {
  constructor(private readonly statePath: string) {}

  async load(): Promise<SecretPersistState> {
    try {
      const raw = await fs.promises.readFile(this.statePath, 'utf8');
      const parsed = JSON.parse(raw) as SecretPersistState;
      return {
        lastScannedCommit: typeof parsed.lastScannedCommit === 'string' ? parsed.lastScannedCommit : '',
        secrets: parsed.secrets && typeof parsed.secrets === 'object' ? parsed.secrets : {},
      };
    } catch {
      return { lastScannedCommit: '', secrets: {} };
    }
  }

  async save(state: SecretPersistState): Promise<void> {
    await fs.promises.mkdir(path.dirname(this.statePath), { recursive: true });
    await fs.promises.writeFile(this.statePath, JSON.stringify(state, null, 2), 'utf8');
  }
}

/** gitleaks 原始 finding（v8 report JSON 字段） */
interface GitleaksFinding {
  RuleID?: string;
  File?: string;
  StartLine?: number;
  Secret?: string;
  Match?: string;
  Commit?: string;
  Date?: string;
}

interface RemoteInfo {
  pushedToRemote: boolean;
  remotePublic: boolean;
}

/**
 * 密钥全生命周期管理器（附 C.3 契约）
 * - scan({history})：工作区 + git 历史增量扫描（边界 3：lastScannedCommit 断点）
 * - markRotating / verifyRotated / dismiss：状态机 + 持久化
 * - 边界 1：轮换引导式，绝不自动轮换
 */
export class SecretLifecycleManager {
  private runner: CommandRunner;
  private store: SecretStore;
  /** 最近一次 scan 的项目路径（verifyRotated 复核重扫用；附 C.3 契约签名不含 path） */
  private lastProjectPath = '';

  constructor(runner?: CommandRunner, store?: SecretStore) {
    this.runner = runner ?? defaultRunner;
    this.store = store ?? new InMemorySecretStore();
  }

  async isGitleaksAvailable(): Promise<boolean> {
    try {
      const { stdout } = await this.runner.run('gitleaks', ['--version'], { timeout: 5000 });
      return stdout.length > 0;
    } catch {
      return false;
    }
  }

  async scan(projectPath: string, opts: { history: boolean }): Promise<SecretScanReport> {
    this.lastProjectPath = projectPath;
    const state = await this.store.load();
    const remote = await this.getRemoteInfo(projectPath);
    const workspaceFindings = await this.runGitleaksDetect(projectPath, undefined);
    const { historyFindings, lastScannedCommit } = await this.collectHistoryFindings(projectPath, opts, state);
    const findings = this.mergeFindings({
      workspaceFindings,
      historyFindings,
      remote,
      state,
    });
    const nextState: SecretPersistState = {
      lastScannedCommit,
      secrets: state.secrets,
    };
    await this.store.save(nextState);
    return this.buildReport(findings, lastScannedCommit);
  }

  private async collectHistoryFindings(
    projectPath: string,
    opts: { history: boolean },
    state: SecretPersistState,
  ): Promise<{ historyFindings: GitleaksFinding[]; lastScannedCommit: string }> {
    let historyFindings: GitleaksFinding[] = [];
    let lastScannedCommit = state.lastScannedCommit;
    if (opts.history) {
      const logOpts = state.lastScannedCommit ? `${state.lastScannedCommit}..HEAD` : '--all';
      historyFindings = await this.runGitleaksDetect(projectPath, logOpts);
      lastScannedCommit = await this.getHeadCommit(projectPath).catch(() => state.lastScannedCommit);
    }
    return { historyFindings, lastScannedCommit };
  }

  private buildReport(findings: SecretFinding[], lastScannedCommit: string): SecretScanReport {
    const sorted = sortFindings(findings);
    return {
      findings: sorted,
      summary: {
        total: sorted.length,
        critical: sorted.filter((f) => f.severity === 'critical').length,
        active: sorted.filter((f) => f.status === 'active').length,
        historyFound: sorted.filter((f) => !f.stillReferenced).length,
      },
      lastScannedCommit,
    };
  }

  async markRotating(secretId: string): Promise<void> {
    await this.transition(secretId, 'rotating', undefined);
  }

  async dismiss(secretId: string, reason: string): Promise<void> {
    await this.transition(secretId, 'dismissed', reason);
  }

  /** 复核：重扫工作区确认值已移除/变更（哈希不同则不再出现）→ 转 rotated */
  async verifyRotated(secretId: string): Promise<boolean> {
    const state = await this.store.load();
    const record = state.secrets[secretId];
    if (!record) return false;
    if (record.status === 'rotated') return true;

    if (!this.lastProjectPath) return false;
    const workspaceFindings = await this.runGitleaksDetect(this.lastProjectPath, undefined);
    const stillPresent = workspaceFindings.some(
      (f) => f.Secret && hashSecret(f.Secret) === secretId,
    );
    if (!stillPresent) {
      await this.transition(secretId, 'rotated', undefined);
      return true;
    }
    return false;
  }

  private async transition(secretId: string, status: SecretStatus, reason: string | undefined): Promise<void> {
    const state = await this.store.load();
    const record: SecretStateRecord = {
      status,
      reason,
      updatedAt: new Date().toISOString(),
    };
    state.secrets[secretId] = record;
    await this.store.save(state);
  }

  private async runGitleaksDetect(projectPath: string, logOpts: string | undefined): Promise<GitleaksFinding[]> {
    const args = ['detect', '--source', projectPath, '--report-format', 'json', '--report-path', '-'];
    if (logOpts) args.push('--log-opts', logOpts);
    const { stdout } = await this.runner.run('gitleaks', args, {
      cwd: projectPath,
      timeout: 120000,
    });
    return this.parseGitleaksOutput(stdout);
  }

  private parseGitleaksOutput(stdout: string): GitleaksFinding[] {
    if (!stdout) return [];
    try {
      const parsed = JSON.parse(stdout) as GitleaksFinding[] | { findings: GitleaksFinding[] };
      return Array.isArray(parsed) ? parsed : (parsed.findings ?? []);
    } catch {
      return [];
    }
  }

  private async getHeadCommit(projectPath: string): Promise<string> {
    const { stdout } = await this.runner.run('git', ['rev-parse', 'HEAD'], { cwd: projectPath, timeout: 10000 });
    return stdout.trim();
  }

  private async getRemoteInfo(projectPath: string): Promise<RemoteInfo> {
    try {
      const { stdout } = await this.runner.run('git', ['remote', 'get-url', 'origin'], {
        cwd: projectPath,
        timeout: 10000,
      });
      const url = stdout.trim();
      if (!url) return { pushedToRemote: false, remotePublic: false };
      return { pushedToRemote: true, remotePublic: isPublicRemoteUrl(url) };
    } catch {
      return { pushedToRemote: false, remotePublic: false };
    }
  }

  private mergeFindings(params: {
    workspaceFindings: GitleaksFinding[];
    historyFindings: GitleaksFinding[];
    remote: RemoteInfo;
    state: SecretPersistState;
  }): SecretFinding[] {
    const { workspaceFindings, historyFindings, remote, state } = params;
    const workspaceSecretIds = new Set<string>();

    const workspaceMapped = workspaceFindings.map((f): SecretFinding => {
      const value = f.Secret || f.Match || '';
      const secretId = hashSecret(value);
      workspaceSecretIds.add(secretId);
      return {
        secretId,
        type: mapRuleToType(f.RuleID ?? ''),
        displayValue: maskSecret(value),
        location: { file: f.File ?? '', line: f.StartLine ?? 0, commit: '' },
        introducedAt: '',
        stillReferenced: true,
        pushedToRemote: remote.pushedToRemote,
        remotePublic: remote.remotePublic,
        severity: classifySeverity({
          stillReferenced: true,
          type: mapRuleToType(f.RuleID ?? ''),
          pushedToRemote: remote.pushedToRemote,
          remotePublic: remote.remotePublic,
        }),
        status: state.secrets[secretId]?.status ?? 'active',
      };
    });

    const historyMapped = historyFindings.map((f): SecretFinding => {
      const value = f.Secret || f.Match || '';
      const secretId = hashSecret(value);
      const type = mapRuleToType(f.RuleID ?? '');
      const stillReferenced = workspaceSecretIds.has(secretId);
      return {
        secretId,
        type,
        displayValue: maskSecret(value),
        location: { file: f.File ?? '', line: f.StartLine ?? 0, commit: f.Commit ?? '' },
        introducedAt: f.Date ?? '',
        stillReferenced,
        pushedToRemote: remote.pushedToRemote,
        remotePublic: remote.remotePublic,
        severity: classifySeverity({ stillReferenced, type, pushedToRemote: remote.pushedToRemote, remotePublic: remote.remotePublic }),
        status: state.secrets[secretId]?.status ?? 'active',
      };
    });

    // 工作区 findings 优先（保留 stillReferenced=true），历史 findings 补齐 commit/引入时间
    const bySecretId = new Map<string, SecretFinding>();
    for (const f of historyMapped) bySecretId.set(f.secretId, f);
    for (const f of workspaceMapped) {
      const existing = bySecretId.get(f.secretId);
      if (existing) {
        bySecretId.set(f.secretId, {
          ...existing,
          stillReferenced: true,
          severity: classifySeverity({
            stillReferenced: true,
            type: existing.type,
            pushedToRemote: remote.pushedToRemote,
            remotePublic: remote.remotePublic,
          }),
        });
      } else {
        bySecretId.set(f.secretId, f);
      }
    }
    return [...bySecretId.values()];
  }
}
