import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import type {
  ToolAdapter,
  ToolMeta,
  ToolResult,
  ToolScanOptions,
  Issue,
  IssueCategory,
  AccessScope,
} from '@zh/shared';

const execFileAsync = promisify(execFile);

const META: Omit<ToolMeta, 'description'> = {
  id: 'commit-lint',
  name: 'Commit Lint',
  category: 'inspect',
  priority: 'P2',
  installMode: 'builtin',
  cliCommand: 'git',
  homepage: 'https://www.conventionalcommits.org',
  license: 'MIT',
};

/** 默认提交信息规范：Conventional Commits（类型可选 scope + 冒号空格 + 描述） */
export const DEFAULT_COMMIT_PATTERN =
  '^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\\(.+\\))?: .+';

export const DEFAULT_MAX_SUBJECT_LENGTH = 72;

/** 校验单条提交信息：返回违规原因，合规返回 null（纯函数，便于单测） */
export function checkCommitSubject(
  subject: string,
  pattern: string,
  maxSubjectLength: number,
): string | null {
  if (subject.length > maxSubjectLength) {
    return `提交描述超长（${subject.length} > ${maxSubjectLength} 字符）`;
  }
  try {
    if (!new RegExp(pattern).test(subject)) {
      return '不符合 Conventional Commits 格式（应为 "type(scope): 描述"）';
    }
  } catch {
    return null; // 非法正则不产生误报
  }
  return null;
}

export class CommitLintAdapter implements ToolAdapter {
  meta: ToolMeta;
  private readonly projectRoot?: string;

  /** F5：commit-lint 读取 .git 提交历史做规范校验 */
  readonly accessScope: AccessScope = {
    readPaths: ['.git/HEAD', '.git/refs/**', '.git/logs/**'],
    excludePaths: [],
  };

  constructor(projectRoot?: string) {
    this.projectRoot = projectRoot;
    this.meta = { ...META, description: '提交信息规范检查（Conventional Commits）' };
  }

  /** 依赖 git 命令（系统自带），无需额外安装 */
  async isAvailable(): Promise<boolean> {
    return true;
  }

  async scan(options: ToolScanOptions): Promise<ToolResult> {
    const start = Date.now();
    const category: IssueCategory = options.config?.category ?? 'quality';
    const pattern = (options.config?.pattern as string) || DEFAULT_COMMIT_PATTERN;
    const maxSubjectLength =
      typeof options.config?.maxSubjectLength === 'number'
        ? options.config.maxSubjectLength
        : DEFAULT_MAX_SUBJECT_LENGTH;

    let subjects: string[];
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['log', '-20', '--pretty=%s'],
        { cwd: options.projectPath, timeout: 15000, maxBuffer: 1024 * 1024 },
      );
      subjects = stdout.split('\n').filter((s) => s.trim().length > 0);
    } catch (error: unknown) {
      // 非 Git 仓库 / git 不可用：属检查前提不满足，跳过而非报错
      return this.buildResult(start, 'unavailable', [], (error as Error).message);
    }

    const issues: Issue[] = [];
    for (const subject of subjects) {
      const reason = checkCommitSubject(subject.trim(), pattern, maxSubjectLength);
      if (!reason) continue;
      issues.push({
        id: randomUUID(),
        ruleId: 'commit-lint/convention',
        severity: 'warning',
        category,
        message: `提交信息不符合规范: "${subject.trim().slice(0, 80)}" — ${reason}`,
        file: '',
        suggestion: `按规范重写提交信息（模式: ${pattern}）`,
        autoFixable: false,
        source: 'inspect',
        fingerprint: `commit-lint:${subject.trim()}`,
      });
    }

    return this.buildResult(start, 'available', issues);
  }

  private buildResult(
    start: number,
    status: 'available' | 'unavailable' | 'error',
    issues: Issue[],
    error?: string,
  ): ToolResult {
    return {
      tool: 'commit-lint',
      status,
      issues,
      metadata: {
        version: '',
        duration: Date.now() - start,
        timestamp: new Date(),
        fileCount: issues.length,
      },
      ...(error ? { error } : {}),
    };
  }
}
