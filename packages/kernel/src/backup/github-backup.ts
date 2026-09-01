/**
 * 一键备份系统 — GitHub API 备份（优先级 2）
 *
 * 需 OAuth 授权，通过 GitHub Git Data API 创建树 → 提交 → 更新分支。
 */
import { type GitHubBackupConfig, type GitHubBackupSubResult } from './types';
import { collectTreeItems } from './github-tree-collector';
import type {
  GitHubApiContext,
  GitHubCommit,
  GitHubRef,
  GitHubTree,
  GitHubTreeItem,
} from './github-api-types';

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
  ): Promise<GitHubBackupSubResult> {
    try {
      const token = await this.ensureAuthenticated();
      await this.ensureRepoExists(config, token, abortSignal);
      const ctx: GitHubApiContext = { owner: config.owner, repo: config.repo, token, abortSignal };
      const parentSha = await this.getParentSha(ctx, config.branch);
      const tree = await this.createTree(ctx, projectPath, config.excludePatterns);
      const { commitMessage, commit } = await this.createBackupCommit(
        ctx,
        config,
        tree.sha,
        parentSha,
      );
      await this.updateRef(ctx, config.branch, commit.sha);
      return this.buildSuccessResult(config, commit, commitMessage);
    } catch (err) {
      return this.buildFailureResult(err);
    }
  }

  /** 检查认证：未授权时抛出错误 */
  private async ensureAuthenticated(): Promise<string> {
    const token = await this.tokenStore.getToken();
    if (!token) {
      throw new Error('GitHub 未授权，请先在设置中授权 GitHub 账户');
    }
    return token;
  }

  /** 检查/创建仓库 */
  private async ensureRepoExists(
    config: GitHubBackupConfig,
    token: string,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    const repoExists = await this.checkRepoExists(config.owner, config.repo, token, abortSignal);
    if (!repoExists) {
      await this.createRepo(config.owner, config.repo, token, abortSignal);
    }
  }

  /** 获取默认分支最新 commit；空仓库或分支不存在时返回 undefined */
  private async getParentSha(ctx: GitHubApiContext, branch: string): Promise<string | undefined> {
    try {
      const ref = await this.getRef(ctx, branch);
      return ref.object.sha;
    } catch {
      return undefined;
    }
  }

  /** 创建提交：生成时间戳消息并调用 GitHub API */
  private async createBackupCommit(
    ctx: GitHubApiContext,
    config: GitHubBackupConfig,
    treeSha: string,
    parentSha: string | undefined,
  ): Promise<{ commitMessage: string; commit: GitHubCommit }> {
    const timestamp = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const commitMessage = `${config.commitPrefix} 自动备份 - ${timestamp}`;
    const commit = await this.createCommit(
      ctx,
      commitMessage,
      treeSha,
      parentSha ? [parentSha] : [],
    );
    return { commitMessage, commit };
  }

  /** 组装成功结果 */
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

  /** 组装失败结果 */
  private buildFailureResult(err: unknown): GitHubBackupSubResult {
    const message = err instanceof Error ? err.message : '未知 GitHub 备份错误';
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

  async handleOAuthCallback(
    code: string,
    clientId: string,
    clientSecret: string,
  ): Promise<boolean> {
    try {
      const response = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
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

  private async checkRepoExists(
    owner: string,
    repo: string,
    token: string,
    abortSignal?: AbortSignal,
  ): Promise<boolean> {
    try {
      await this.githubFetch(
        `https://api.github.com/repos/${owner}/${repo}`,
        token,
        {},
        abortSignal,
      );
      return true;
    } catch {
      return false;
    }
  }

  private async createRepo(
    owner: string,
    repo: string,
    token: string,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    await this.githubFetch(
      'https://api.github.com/user/repos',
      token,
      {
        method: 'POST',
        body: JSON.stringify({
          name: repo,
          private: true,
          auto_init: false,
          description: '智汇码盾自动备份仓库',
        }),
      },
      abortSignal,
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
    await collectTreeItems(ctx, projectPath, '', excludePatterns, tree);
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

  private async updateRef(ctx: GitHubApiContext, branch: string, commitSha: string): Promise<void> {
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
