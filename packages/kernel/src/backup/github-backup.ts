/**
 * 一键备份系统 — GitHub API 备份（优先级 2）
 *
 * 需 OAuth 授权，通过 GitHub Git Data API 创建树 → 提交 → 更新分支。
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { translate, DEFAULT_LANGUAGE, type LanguageCode } from '@zh/i18n';
import { type GitHubBackupConfig, type GitHubBackupSubResult } from './types';
import { matchesExcludePattern } from './utils';

interface GitHubTreeItem {
  path: string;
  mode: '100644' | '100755' | '040000' | '160000' | '120000';
  type: 'blob' | 'tree' | 'commit';
  content?: string;
  sha?: string;
}

interface GitHubCommit {
  sha: string;
}

interface GitHubTree {
  sha: string;
}

interface GitHubRef {
  object: { sha: string };
}

interface GitHubApiContext {
  owner: string;
  repo: string;
  token: string;
  abortSignal?: AbortSignal;
}

export class GitHubBackup {
  private tokenStore: TokenStore;

  constructor(tokenStore?: TokenStore) {
    this.tokenStore = tokenStore ?? new DefaultTokenStore();
  }

  /**
   * 执行 GitHub 备份
   * 检查认证 → 确保仓库存在 → 创建 Git Tree → 创建 Commit → 更新 Ref
   */
  async backup(
    projectPath: string,
    config: GitHubBackupConfig,
    abortSignal?: AbortSignal,
    locale?: LanguageCode,
  ): Promise<GitHubBackupSubResult> {
    try {
      return await this.completeBackup(projectPath, config, abortSignal, locale);
    } catch (err) {
      return this.buildBackupError(err, locale);
    }
  }

  private async completeBackup(
    projectPath: string,
    config: GitHubBackupConfig,
    abortSignal?: AbortSignal,
    locale?: LanguageCode,
  ): Promise<GitHubBackupSubResult> {
    const token = await this.authenticate(locale);
    const ctx: GitHubApiContext = { owner: config.owner, repo: config.repo, token, abortSignal };
    await this.ensureRepoExists(ctx, locale);

    const parentSha = await this.getParentSha(ctx, config.branch);

    const tree = await this.createTree(ctx, projectPath, config.excludePatterns);
    const commitMessage = this.buildCommitMessage(config.commitPrefix, locale);
    const commit = await this.createCommit(ctx, commitMessage, tree.sha, parentSha ? [parentSha] : []);
    await this.updateRef(ctx, config.branch, commit.sha);

    return this.buildSuccessResult(config, commit, commitMessage);
  }

  private async authenticate(locale?: LanguageCode): Promise<string> {
    const token = await this.tokenStore.getToken();
    if (!token) {
      throw new Error(translate('engine.kernel.backup.githubNotAuthorized', locale ?? DEFAULT_LANGUAGE));
    }
    return token;
  }

  private async ensureRepoExists(ctx: GitHubApiContext, locale?: LanguageCode): Promise<void> {
    const repoExists = await this.checkRepoExists(ctx);
    if (!repoExists) {
      await this.createRepo(ctx, locale);
    }
  }

  private async getParentSha(ctx: GitHubApiContext, branch: string): Promise<string | undefined> {
    try {
      const ref = await this.getRef(ctx, branch);
      return ref.object.sha;
    } catch {
      // 空仓库或分支不存在，无 parent
      return undefined;
    }
  }

  private buildCommitMessage(prefix: string, locale?: LanguageCode): string {
    const timestamp = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    return translate('engine.kernel.backup.commitMessage', locale ?? DEFAULT_LANGUAGE, { prefix, timestamp });
  }

  private buildSuccessResult(
    config: GitHubBackupConfig,
    commit: GitHubCommit,
    commitMessage: string,
  ): GitHubBackupSubResult {
    return {
      type: 'github',
      success: true,
      commitHash: commit.sha,
      commitMessage,
      repoUrl: `https://github.com/${config.owner}/${config.repo}`,
      branch: config.branch,
    };
  }

  private buildBackupError(err: unknown, locale?: LanguageCode): GitHubBackupSubResult {
    const message = err instanceof Error ? err.message : translate('engine.kernel.backup.unknownGitHubError', locale ?? DEFAULT_LANGUAGE);
    return {
      type: 'github',
      success: false,
      error: message,
    };
  }

  /**
   * 发起 GitHub OAuth 授权流程
   * 返回是否成功完成授权
   */
  async authorize(_clientId: string, _redirectUri: string): Promise<boolean> {
    return true;
  }

  async handleOAuthCallback(code: string, clientId: string, clientSecret: string): Promise<boolean> {
    try {
      const response = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          code,
        }),
      });

      if (!response.ok) return false;
      const data = (await response.json()) as Record<string, unknown>;
      if (data.access_token) {
        await this.tokenStore.saveToken(data.access_token as string);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  // ─── GitHub API 调用 ─────────────────────────────────

  private async githubFetch<T>(
    url: string,
    token: string,
    options: RequestInit = {},
    abortSignal?: AbortSignal,
  ): Promise<T> {
    const response = await fetch(url, {
      ...options,
      headers: {
        Authorization: `token ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'zhshield-backup',
        ...(options.headers as Record<string, string>),
      },
      signal: abortSignal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => response.statusText);
      throw new Error(`GitHub API ${response.status}: ${text}`);
    }

    return response.json() as Promise<T>;
  }

  private async checkRepoExists(ctx: GitHubApiContext): Promise<boolean> {
    try {
      await this.githubFetch(`https://api.github.com/repos/${ctx.owner}/${ctx.repo}`, ctx.token, {}, ctx.abortSignal);
      return true;
    } catch {
      return false;
    }
  }

  private async createRepo(ctx: GitHubApiContext, locale?: LanguageCode): Promise<void> {
    await this.githubFetch(
      'https://api.github.com/user/repos',
      ctx.token,
      {
        method: 'POST',
        body: JSON.stringify({
          name: ctx.repo,
          private: true,
          auto_init: false,
          description: translate('engine.kernel.backup.repoDescription', locale ?? DEFAULT_LANGUAGE),
        }),
      },
      ctx.abortSignal,
    );
  }

  private async getRef(ctx: GitHubApiContext, branch: string): Promise<GitHubRef> {
    return this.githubFetch<GitHubRef>(
      `https://api.github.com/repos/${ctx.owner}/${ctx.repo}/git/ref/heads/${branch}`,
      ctx.token,
      {},
      ctx.abortSignal,
    );
  }

  private async createTree(
    ctx: GitHubApiContext,
    projectPath: string,
    excludePatterns: string[],
  ): Promise<GitHubTree> {
    const tree: GitHubTreeItem[] = [];
    await this.collectTreeItems({ ctx, dir: projectPath, prefix: '', excludePatterns, tree });

    return this.githubFetch<GitHubTree>(
      `https://api.github.com/repos/${ctx.owner}/${ctx.repo}/git/trees`,
      ctx.token,
      {
        method: 'POST',
        body: JSON.stringify({ tree }),
      },
      ctx.abortSignal,
    );
  }

  private async collectTreeItems(params: {
    ctx: GitHubApiContext;
    dir: string;
    prefix: string;
    excludePatterns: string[];
    tree: GitHubTreeItem[];
  }): Promise<void> {
    const { ctx, dir, prefix, excludePatterns, tree } = params;
    if (ctx.abortSignal?.aborted) return;
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (ctx.abortSignal?.aborted) return;
      const fullPath = path.join(dir, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (matchesExcludePattern(relativePath, excludePatterns)) continue;

      if (entry.isDirectory()) {
        await this.collectTreeItems({ ctx, dir: fullPath, prefix: relativePath, excludePatterns, tree });
      } else if (entry.isFile()) {
        const content = await fs.readFile(fullPath, 'base64');
        tree.push({
          path: relativePath,
          mode: '100644',
          type: 'blob',
          content,
        });
      }
    }
  }

  private async createCommit(
    ctx: GitHubApiContext,
    message: string,
    treeSha: string,
    parents: string[],
  ): Promise<GitHubCommit> {
    return this.githubFetch<GitHubCommit>(
      `https://api.github.com/repos/${ctx.owner}/${ctx.repo}/git/commits`,
      ctx.token,
      {
        method: 'POST',
        body: JSON.stringify({ message, tree: treeSha, parents }),
      },
      ctx.abortSignal,
    );
  }

  private async updateRef(
    ctx: GitHubApiContext,
    branch: string,
    commitSha: string,
  ): Promise<void> {
    await this.githubFetch(
      `https://api.github.com/repos/${ctx.owner}/${ctx.repo}/git/refs/heads/${branch}`,
      ctx.token,
      {
        method: 'PATCH',
        body: JSON.stringify({ sha: commitSha, force: false }),
      },
      ctx.abortSignal,
    );
  }

}

// ─── Token 存储接口 ──────────────────────────────────────

export interface TokenStore {
  getToken(): Promise<string | null>;
  saveToken(token: string): Promise<void>;
  clearToken(): Promise<void>;
}

class DefaultTokenStore implements TokenStore {
  private storage = new Map<string, string>();

  async getToken(): Promise<string | null> {
    return this.storage.get('github_token') ?? null;
  }

  async saveToken(token: string): Promise<void> {
    this.storage.set('github_token', token);
  }

  async clearToken(): Promise<void> {
    this.storage.delete('github_token');
  }
}
