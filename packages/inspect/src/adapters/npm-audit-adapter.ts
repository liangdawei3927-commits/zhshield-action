import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
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

export class NpmAuditAdapter implements ToolAdapter {
  meta: ToolMeta;
  private readonly projectRoot?: string;

  /** F5：npm/pnpm audit 读取锁文件并联网查询漏洞库 */
  readonly accessScope: AccessScope = {
    readPaths: ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'package.json'],
    excludePaths: [],
  };

  constructor(projectRoot?: string) {
    this.projectRoot = projectRoot;
    this.meta = { ...META, description: '依赖已知漏洞审计（npm/pnpm audit）' };
  }

  /** 依赖 npm/pnpm 命令，锁文件存在时即可执行 */
  async isAvailable(): Promise<boolean> {
    return true;
  }

  async scan(options: ToolScanOptions): Promise<ToolResult> {
    const start = Date.now();
    const category: IssueCategory = options.config?.category ?? 'dependency';

    const command = AUDIT_COMMANDS.find((c) =>
      fs.existsSync(path.join(options.projectPath, c.lockfile)),
    );
    if (!command) {
      return this.buildResult(
        start,
        'unavailable',
        [],
        '未找到 pnpm-lock.yaml / package-lock.json 锁文件，跳过依赖审计',
      );
    }

    let raw = '';
    try {
      ({ stdout: raw } = await execFileAsync(command.cmd, command.args, {
        cwd: options.projectPath,
        timeout: options.timeout || 120000,
        maxBuffer: 10 * 1024 * 1024,
      }));
    } catch (error: unknown) {
      // npm/pnpm audit 发现漏洞时以非零码退出，stdout 仍为完整 JSON 报告 — 属正常路径
      const err = error as { stdout?: string; message?: string };
      raw = err.stdout ?? '';
      if (!raw.trim()) {
        return this.buildResult(start, 'error', [], err.message || `${command.cmd} audit 执行失败`);
      }
    }

    const vulns = parseAuditVulnerabilities(raw);
    if (!vulns) {
      return this.buildResult(start, 'error', [], 'audit 报告解析失败（非 JSON 或缺少 metadata）');
    }

    const issues = this.toIssues(vulns, category);
    return this.buildResult(start, 'available', issues);
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
    return {
      tool: 'npm-audit',
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
