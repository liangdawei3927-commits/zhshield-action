// @zh/security secrets — 密钥生命周期支撑层：常量表、纯函数、命令执行器与状态存储。
// 自 lifecycle.ts 原样抽出（仅搬移，无逻辑改动）；lifecycle.ts 保留管理器与内存存储并转发导出。
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  CommandRunner,
  SecretFinding,
  SecretPersistState,
  SecretSeverity,
  SecretType,
} from './types';

const execFileAsync = promisify(execFile);

const SCHEME_RE = /^[a-z]+:\/\//i;
const USER_RE = /^[^@]+@/;
const HOST_SPLIT_RE = /[:/]/;

/**
 * gitleaks findings 中与 Guard 其他适配器约定一致的排除路径
 * （与 GitleaksAdapter.EXCLUDED_FILE_PATTERN 保持同一语义，
 * 见 packages/inspect/src/adapters/gitleaks-adapter.ts）：
 * - 构建产物 / 依赖不参与密钥扫描：CLI 自包含 bundle（packages/cli/dist/zhshield.js）
 *   内嵌 eslint-visitor-keys 等第三方库，其变量名（eslintVisitorKeys / visitorKeys）
 *   会被 generic-api-key 误报，提交后必然阻断门禁；
 * - 测试目录中的固定密钥字符串是夹具而非真实泄露（与 security-check-engine 的
 *   SKIP_DIRS：__tests__/fixtures/test，及规则模板排除测试文件的约定保持一致）。
 */
export const EXCLUDED_FILE_PATTERN =
  /(^|\/)(dist|build|coverage|node_modules|__tests__|__fixtures__|fixtures|test|tests)(\/|$)|\.map$|\.min\.js$|\.(test|spec)\.[jt]sx?$/;

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
  return (
    PUBLIC_HOSTS.has(host) || Array.from(PUBLIC_HOSTS, (h) => h).some((h) => host.endsWith(`.${h}`))
  );
}

/** 默认命令执行器：gitleaks 检出密钥时退出码非 0 但 stdout 含有效 JSON，需保留 stdout */
export const defaultRunner: CommandRunner = {
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

/** 文件存储（.zhshield/secrets-state.json；只存 hash/状态/原因，不落明文） */
export class FileSecretStore implements SecretStore {
  constructor(private readonly statePath: string) {}

  async load(): Promise<SecretPersistState> {
    try {
      const raw = await fs.promises.readFile(this.statePath, 'utf8');
      const parsed = JSON.parse(raw) as SecretPersistState;
      return {
        lastScannedCommit:
          typeof parsed.lastScannedCommit === 'string' ? parsed.lastScannedCommit : '',
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
export interface GitleaksFinding {
  RuleID?: string;
  File?: string;
  StartLine?: number;
  Secret?: string;
  Match?: string;
  Commit?: string;
  Date?: string;
}

/** git remote 推送状态（scan 合并 findings 时的严重度判定输入） */
export interface RemoteInfo {
  pushedToRemote: boolean;
  remotePublic: boolean;
}
