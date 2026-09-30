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

/** Git 提交对象引用：仅取回滚所需的 sha 字段 */
export interface GitHubCommit {
  sha: string;
}

/** Git 树对象引用：仅取 sha 字段，条目内容另由 {@link GitHubTreeItem} 承载 */
export interface GitHubTree {
  sha: string;
}

/** Git 引用（如 refs/heads/main）：object.sha 指向其指向的提交或树 */
export interface GitHubRef {
  object: { sha: string };
}

/**
 * GitHub API 调用上下文。
 * abortSignal 用于超时或取消，避免请求悬挂。
 */
export interface GitHubApiContext {
  owner: string;
  repo: string;
  token: string;
  abortSignal?: AbortSignal;
}
