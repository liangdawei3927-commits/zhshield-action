import { EventBus } from '../bus';
import {
  type BackupResult,
  type BackupSubResult,
  type BackupTrigger,
  type BackupRecord,
  type BackupStatus,
  type GitHubBackupSubResult,
  type LocalBackupSubResult,
  BACKUP_EVENTS,
} from './types';
import { BackupConfigManager } from './config';
import { GitHubBackup } from './github-backup';
import { LocalBackup } from './local-backup';

export interface BackupOrchestratorOptions {
  eventBus?: EventBus;
  configManager?: BackupConfigManager;
  githubBackup?: GitHubBackup;
  localBackup?: LocalBackup;
}

export interface ExecuteOptions {
  projectId: string;
  projectPath: string;
  projectName?: string;
  trigger?: BackupTrigger;
  abortSignal?: AbortSignal;
}

export class BackupOrchestrator {
  private eventBus?: EventBus;
  private configManager: BackupConfigManager;
  private githubBackup: GitHubBackup;
  private localBackup: LocalBackup;
  private records: BackupRecord[] = [];

  constructor(options?: BackupOrchestratorOptions) {
    this.eventBus = options?.eventBus;
    this.configManager = options?.configManager ?? new BackupConfigManager();
    this.githubBackup = options?.githubBackup ?? new GitHubBackup();
    this.localBackup = options?.localBackup ?? new LocalBackup();
  }

  async execute(options: ExecuteOptions): Promise<BackupResult> {
    const { projectId, projectPath, trigger = 'manual', abortSignal } = options;
    let { projectName } = options;
    const startTime = Date.now();
    const backupId = this.generateBackupId();

    this.emit(BACKUP_EVENTS.STARTED, { projectId, backupId, type: 'full' });

    const config = await this.configManager.loadProjectConfig(projectPath);
    if (!projectName) {
      projectName = projectId;
    }

    const results: BackupSubResult[] = [];

    if (config.github.enabled && !abortSignal?.aborted) {
      this.emitProgress({ projectId, backupId, phase: 'github-commit', percent: 40, message: '正在提交到 GitHub...' });
      const githubResult = await this.githubBackup.backup(projectPath, config.github, abortSignal);
      results.push(githubResult);
    }

    if (config.local.enabled && !abortSignal?.aborted) {
      this.emitProgress({ projectId, backupId, phase: 'local-copy', percent: 70, message: '正在复制到本地目录...' });
      const localResult = await this.localBackup.backup(projectPath, config.local, abortSignal);
      results.push(localResult);
    }

    const overallStatus = this.calculateOverallStatus(results);
    const duration = Date.now() - startTime;

    const result: BackupResult = {
      projectId,
      projectName: projectName ?? projectId,
      trigger: trigger,
      results,
      overallStatus,
      timestamp: new Date(),
      duration,
    };

    this.saveRecord(result, projectPath);

    if (overallStatus === 'failed') {
      this.emit(BACKUP_EVENTS.FAILED, {
        projectId, backupId,
        error: '所有备份方式均失败',
        partialResult: result,
      });
    } else {
      this.emitProgress({ projectId, backupId, phase: 'local-metadata', percent: 100, message: '备份完成' });
      this.emit(BACKUP_EVENTS.COMPLETED, { projectId, backupId, result });
    }

    return result;
  }

  async executeGitHubOnly(projectId: string, projectPath: string): Promise<BackupSubResult> {
    const config = await this.configManager.loadProjectConfig(projectPath);
    return this.githubBackup.backup(projectPath, config.github);
  }

  async executeLocalOnly(projectId: string, projectPath: string): Promise<BackupSubResult> {
    const config = await this.configManager.loadProjectConfig(projectPath);
    return this.localBackup.backup(projectPath, config.local);
  }

  getRecords(projectId?: string): BackupRecord[] {
    if (projectId) {
      return this.records.filter((r) => r.projectId === projectId);
    }
    return [...this.records];
  }

  getRecord(recordId: string): BackupRecord | undefined {
    return this.records.find((r) => r.id === recordId);
  }

  deleteRecord(recordId: string): boolean {
    const idx = this.records.findIndex((r) => r.id === recordId);
    if (idx === -1) return false;
    this.records.splice(idx, 1);
    return true;
  }

  loadRecords(records: BackupRecord[]): void {
    this.records = records;
  }

  getConfigManager(): BackupConfigManager {
    return this.configManager;
  }

  private calculateOverallStatus(results: BackupSubResult[]): BackupStatus {
    if (results.length === 0) return 'failed';
    const successCount = results.filter((r) => r.success).length;
    if (successCount === results.length) return 'success';
    if (successCount > 0) return 'partial';
    return 'failed';
  }

  private saveRecord(result: BackupResult, projectPath: string): void {
    const findResult = <T extends BackupSubResult>(type: string): T | undefined =>
      result.results.find((r): r is T => r.type === type);

    const github = findResult<GitHubBackupSubResult>('github');
    const local = findResult<LocalBackupSubResult>('local');

    const record: BackupRecord = {
      id: this.generateBackupId(),
      projectId: result.projectId,
      projectName: result.projectName,
      projectPath,
      timestamp: result.timestamp.toISOString(),
      type: result.results.length > 1 ? 'full' : 'local-only',
      status: result.overallStatus,
      trigger: result.trigger,
      duration: result.duration,
      githubCommitHash: github?.commitHash,
      githubCommitMessage: github?.commitMessage,
      githubRepoUrl: github?.repoUrl,
      githubBranch: github?.branch,
      localBackupPath: local?.backupPath,
      backupSize: local?.size,
      fileCount: local?.fileCount,
      error: result.results.find((r) => !r.success)?.error,
    };

    this.records.unshift(record);
    if (this.records.length > 100) {
      this.records = this.records.slice(0, 100);
    }
  }

  private emitProgress(info: {
    projectId: string;
    backupId: string;
    phase: string;
    percent: number;
    message: string;
  }): void {
    this.emit(BACKUP_EVENTS.PROGRESS, info);
  }

  private emit(event: string, payload: unknown): void {
    this.eventBus?.emit(event, payload).catch(() => {});
  }

  private generateBackupId(): string {
    const now = new Date();
    const date = now.toISOString().slice(0, 10).replace(/-/g, '');
    const time = now.toTimeString().slice(0, 8).replace(/:/g, '');
    const rand = Math.random().toString(36).slice(2, 6);
    return `bk_${date}_${time}_${rand}`;
  }
}
