/**
 * GitHub 备份 — GitHub API 共享类型
 */

export interface GitHubTreeItem {
  path: string;
  mode: '100644' | '100755' | '040000' | '160000' | '120000';
  type: 'blob' | 'tree' | 'commit';
  content?: string;
  sha?: string;
}

export interface GitHubCommit {
  sha: string;
}

export interface GitHubTree {
  sha: string;
}

export interface GitHubRef {
  object: { sha: string };
}

export interface GitHubApiContext {
  owner: string;
  repo: string;
  token: string;
  abortSignal?: AbortSignal;
}
