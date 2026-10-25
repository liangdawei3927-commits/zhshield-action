// @zh/security secrets — 密钥全生命周期（附 C：发现→定位→评估→轮换→复核 5 步闭环）
// 常量表 / 纯函数 / 默认执行器 / 文件存储已抽出至同目录 lifecycle-utils.ts，
// 此处保留内存存储与生命周期管理器，并转发全部原导出（对外接口不变）。
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  CommandRunner,
  SecretFinding,
  SecretPersistState,
  SecretScanReport,
  SecretStateRecord,
  SecretStatus,
} from './types';
import {
  EXCLUDED_FILE_PATTERN,
  defaultRunner,
  hashSecret,
  maskSecret,
  mapRuleToType,
  classifySeverity,
  sortFindings,
  isPublicRemoteUrl,
} from './lifecycle-utils';
import type { SecretStore, GitleaksFinding, RemoteInfo } from './lifecycle-utils';

// 对外导出保持不变（支撑实现已抽出至 lifecycle-utils.ts，此处仅转发）
export type { SecretStore } from './lifecycle-utils';
export {
  FileSecretStore,
  hashSecret,
  maskSecret,
  mapRuleToType,
  classifySeverity,
  sortFindings,
  parseRemoteHost,
  isPublicRemoteUrl,
} from './lifecycle-utils';

/**
 * 内存存储（默认，测试友好）。
 *
 * 经核实不是冗余薄壳（lazy-class 误报）：它是 SecretStore 的第二个实现——
 * 生产侧 FileSecretStore 落盘 .zhshield/secrets-state.json 供 engines-secrets 注入，
 * 此处供测试与无盘场景注入，二者共同支撑 SecretLifecycleManager 的构造注入，
 * 并经 @zh/security 公开导出；移除会破坏对外 API，内联进调用方会拆掉注入接缝。
 * 另外 load/save 的双向浅拷贝是行为契约：transition() 在 load() 之后原地改
 * state.secrets，若无拷贝会直接污染 store 的内部状态。
 */
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
    const { historyFindings, lastScannedCommit } = await this.collectHistoryFindings(
      projectPath,
      opts,
      state,
    );
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
      lastScannedCommit = await this.getHeadCommit(projectPath).catch(
        () => state.lastScannedCommit,
      );
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

  private async transition(
    secretId: string,
    status: SecretStatus,
    reason: string | undefined,
  ): Promise<void> {
    const state = await this.store.load();
    const record: SecretStateRecord = {
      status,
      reason,
      updatedAt: new Date().toISOString(),
    };
    state.secrets[secretId] = record;
    await this.store.save(state);
  }

  private isGitRepo(dir: string): boolean {
    try {
      return fs.existsSync(path.join(dir, '.git'));
    } catch {
      return false;
    }
  }

  private async runGitleaksDetect(
    projectPath: string,
    logOpts: string | undefined,
  ): Promise<GitleaksFinding[]> {
    const args = [
      'detect',
      '--source',
      projectPath,
      '--report-format',
      'json',
      '--report-path',
      '-',
    ];
    if (logOpts) args.push('--log-opts', logOpts);
    // 非 git 仓库时追加 --no-git，避免 gitleaks 向上查找父级 git 仓库导致漏检
    if (!logOpts && !this.isGitRepo(projectPath)) {
      args.push('--no-git');
    }
    const { stdout } = await this.runner.run('gitleaks', args, {
      cwd: projectPath,
      timeout: 120000,
    });
    // 工作区与历史 findings 统一过滤既定误报路径（dist/构建产物内嵌第三方库变量名、测试夹具）
    return this.parseGitleaksOutput(stdout).filter(
      (f) => !EXCLUDED_FILE_PATTERN.test(f.File || ''),
    );
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
    const { stdout } = await this.runner.run('git', ['rev-parse', 'HEAD'], {
      cwd: projectPath,
      timeout: 10000,
    });
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
        severity: classifySeverity({
          stillReferenced,
          type,
          pushedToRemote: remote.pushedToRemote,
          remotePublic: remote.remotePublic,
        }),
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
