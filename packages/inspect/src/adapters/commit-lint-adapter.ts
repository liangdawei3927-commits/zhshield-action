import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import {
  BuiltinToolAdapter,
  type ToolMeta,
  type ToolResult,
  type ToolScanOptions,
  type Issue,
  type IssueCategory,
  type AccessScope,
} from '@zh/shared';
import { buildAccessScope, buildToolResult, execTool } from './tool-runner';

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

/** 从 options.config 解析提交规范参数（category / pattern / maxSubjectLength） */
function resolveCommitLintConfig(options: ToolScanOptions): {
  category: IssueCategory;
  pattern: string;
  maxSubjectLength: number;
} {
  const category: IssueCategory = options.config?.category ?? 'quality';
  const pattern = (options.config?.pattern as string) || DEFAULT_COMMIT_PATTERN;
  const maxSubjectLength =
    typeof options.config?.maxSubjectLength === 'number'
      ? options.config.maxSubjectLength
      : DEFAULT_MAX_SUBJECT_LENGTH;
  return { category, pattern, maxSubjectLength };
}

/** 读取最近 20 条提交主题（git log），失败时抛出由调用方决定跳过 */
async function loadCommitSubjects(projectPath: string): Promise<string[]> {
  const { stdout } = await execTool('git', ['log', '-20', '--pretty=%s'], {
    cwd: projectPath,
    timeout: 15000,
    maxBuffer: 1024 * 1024,
  });
  return stdout.split('\n').filter((s) => s.trim().length > 0);
}

/** 逐条校验提交主题并生成违规 Issue */
function buildCommitIssues(
  subjects: string[],
  pattern: string,
  maxSubjectLength: number,
  category: IssueCategory,
): Issue[] {
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
  return issues;
}

export class CommitLintAdapter extends BuiltinToolAdapter {
  meta: ToolMeta;
  private readonly projectRoot?: string;

  /** F5：commit-lint 读取 .git 提交历史做规范校验 */
  readonly accessScope: AccessScope = buildAccessScope(
    ['.git/HEAD', '.git/refs/**', '.git/logs/**'],
    [],
  );

  constructor(projectRoot?: string) {
    super();
    this.projectRoot = projectRoot;
    this.meta = { ...META, description: '提交信息规范检查（Conventional Commits）' };
  }

  /** 读取提交主题；git 不可用（非 Git 仓库）时返回 unavailable 结果而非报错 */
  private async loadSubjectsOrUnavailable(
    options: ToolScanOptions,
    start: number,
  ): Promise<{ subjects: string[] } | { result: ToolResult }> {
    try {
      const subjects = await loadCommitSubjects(path.resolve(options.projectPath));
      return { subjects };
    } catch (error: unknown) {
      // 非 Git 仓库 / git 不可用：属检查前提不满足，跳过而非报错
      return { result: this.buildResult(start, 'unavailable', [], (error as Error).message) };
    }
  }

  async scan(options: ToolScanOptions): Promise<ToolResult> {
    const start = Date.now();
    const { category, pattern, maxSubjectLength } = resolveCommitLintConfig(options);
    const loaded = await this.loadSubjectsOrUnavailable(options, start);
    if ('result' in loaded) return loaded.result;

    const issues = buildCommitIssues(loaded.subjects, pattern, maxSubjectLength, category);
    return this.buildResult(start, 'available', issues);
  }

  private buildResult(
    start: number,
    status: 'available' | 'unavailable' | 'error',
    issues: Issue[],
    error?: string,
  ): ToolResult {
    return buildToolResult({ tool: 'commit-lint', status, issues, start, error });
  }
}
