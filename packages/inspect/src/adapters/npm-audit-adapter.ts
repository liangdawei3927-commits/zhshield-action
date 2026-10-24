import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
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
import { buildAccessScope, buildToolResult, execTool, asToolExecError } from './tool-runner';

const META: Omit<ToolMeta, 'description'> = {
  id: 'npm-audit',
  name: 'Dependency Audit',
  category: 'inspect',
  priority: 'P1',
  installMode: 'builtin',
  cliCommand: 'npm',
  homepage: 'https://docs.npmjs.com/cli/audit',
  license: 'MIT',
};

/** 各包管理器 audit 命令（按锁文件探测） */
const AUDIT_COMMANDS: Array<{ lockfile: string; cmd: string; args: string[] }> = [
  { lockfile: 'pnpm-lock.yaml', cmd: 'pnpm', args: ['audit', '--json'] },
  { lockfile: 'package-lock.json', cmd: 'npm', args: ['audit', '--json'] },
];

/**
 * 归一化 projectPath 为绝对路径并探测锁文件对应的 audit 命令。
 * 相对路径会流入锁文件探测与 cwd，npm/pnpm 以自身 cwd 解析相对路径导致扫描失败。
 */
function resolveAuditCommand(
  projectPath: string,
): { command: { cmd: string; args: string[] } | undefined; projectPath: string } {
  const resolved = path.resolve(projectPath);
  const command = AUDIT_COMMANDS.find((c) => fs.existsSync(path.join(resolved, c.lockfile)));
  return { command, projectPath: resolved };
}

/** audit JSON 报告中的漏洞计数（npm/pnpm 均提供 metadata.vulnerabilities） */
interface AuditVulnerabilities {
  info?: number;
  low?: number;
  moderate?: number;
  high?: number;
  critical?: number;
}

/** 防御性解析 audit JSON：提取各严重级漏洞计数，解析失败返回 null */
export function parseAuditVulnerabilities(raw: string): AuditVulnerabilities | null {
  try {
    const parsed = JSON.parse(raw) as {
      metadata?: { vulnerabilities?: AuditVulnerabilities };
    };
    const v = parsed.metadata?.vulnerabilities;
    if (!v || typeof v !== 'object') return null;
    return v;
  } catch {
    return null;
  }
}

export class NpmAuditAdapter extends BuiltinToolAdapter {
  meta: ToolMeta;
  private readonly projectRoot?: string;

  /** F5：npm/pnpm audit 读取锁文件并联网查询漏洞库 */
  readonly accessScope: AccessScope = buildAccessScope(
    ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'package.json'],
    [],
  );

  constructor(projectRoot?: string) {
    super();
    this.projectRoot = projectRoot;
    this.meta = { ...META, description: '依赖已知漏洞审计（npm/pnpm audit）' };
  }

  async scan(options: ToolScanOptions): Promise<ToolResult> {
    const start = Date.now();
    const category: IssueCategory = options.config?.category ?? 'dependency';
    const { command, projectPath } = resolveAuditCommand(options.projectPath);
    if (!command) {
      return this.buildResult(
        start,
        'unavailable',
        [],
        '未找到 pnpm-lock.yaml / package-lock.json 锁文件，跳过依赖审计',
      );
    }

    const { raw, errorMessage } = await this.runAuditCommand(
      command,
      projectPath,
      options.timeout || 120000,
    );
    if (errorMessage) {
      return this.buildResult(start, 'error', [], errorMessage);
    }

    const vulns = parseAuditVulnerabilities(raw);
    if (!vulns) {
      return this.buildResult(start, 'error', [], 'audit 报告解析失败（非 JSON 或缺少 metadata）');
    }

    const issues = this.toIssues(vulns, category);
    return this.buildResult(start, 'available', issues);
  }

  /** 执行 audit 命令：漏洞命中时以非零码退出但 stdout 仍为完整 JSON 报告，属正常路径 */
  private async runAuditCommand(
    command: { cmd: string; args: string[] },
    projectPath: string,
    timeout: number,
  ): Promise<{ raw: string; errorMessage?: string }> {
    let raw: string;
    try {
      ({ stdout: raw } = await execTool(command.cmd, command.args, {
        cwd: projectPath,
        timeout,
      }));
    } catch (error: unknown) {
      // npm/pnpm audit 发现漏洞时以非零码退出，stdout 仍为完整 JSON 报告 — 属正常路径
      const err = asToolExecError(error);
      raw = err.stdout ?? '';
      if (!raw.trim()) {
        return { raw, errorMessage: err.message || `${command.cmd} audit 执行失败` };
      }
    }
    return { raw };
  }

  /** 漏洞计数 → Issue：每个非零严重级生成一条聚合问题 */
  private toIssues(vulns: AuditVulnerabilities, category: IssueCategory): Issue[] {
    const levels: Array<{
      key: keyof AuditVulnerabilities;
      severity: Issue['severity'];
      label: string;
    }> = [
      { key: 'critical', severity: 'error', label: 'critical' },
      { key: 'high', severity: 'error', label: 'high' },
      { key: 'moderate', severity: 'warning', label: 'moderate' },
      { key: 'low', severity: 'info', label: 'low' },
      { key: 'info', severity: 'info', label: 'info' },
    ];
    const issues: Issue[] = [];
    for (const { key, severity, label } of levels) {
      const count = vulns[key] ?? 0;
      if (count <= 0) continue;
      issues.push({
        id: randomUUID(),
        ruleId: `npm-audit/${label}`,
        severity,
        category,
        message: `发现 ${count} 个 ${label} 级依赖漏洞`,
        file: '',
        suggestion: '运行 audit 修复命令升级受影响依赖，或锁定安全版本',
        autoFixable: false,
        source: 'inspect',
        fingerprint: `npm-audit:${label}:${count}`,
      });
    }
    return issues;
  }

  private buildResult(
    start: number,
    status: 'available' | 'unavailable' | 'error',
    issues: Issue[],
    error?: string,
  ): ToolResult {
    return buildToolResult({ tool: 'npm-audit', status, issues, start, error });
  }
}
