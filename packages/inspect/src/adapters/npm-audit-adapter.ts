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

/** pnpm 报告里的 advisory 条目（只取本模块用到的字段） */
interface AuditAdvisory {
  severity?: string;
}

const SEVERITY_KEYS = ['info', 'low', 'moderate', 'high', 'critical'] as const;

/**
 * 按 advisory 逐条统计各严重级条数（未知 severity 跳过）。
 *
 * 与 `metadata.vulnerabilities` 的口径差异：metadata 数的是**受影响包数**，
 * 这里数的是**漏洞条数**，与 issue 文案「发现 N 个 X 级依赖漏洞」一致。
 */
function countAdvisories(advisories: Record<string, AuditAdvisory>): AuditVulnerabilities {
  const counts: AuditVulnerabilities = {};
  for (const advisory of Object.values(advisories)) {
    const key = (advisory?.severity || '').toLowerCase();
    if (!(SEVERITY_KEYS as readonly string[]).includes(key)) continue;
    const typed = key as keyof AuditVulnerabilities;
    counts[typed] = (counts[typed] ?? 0) + 1;
  }
  return counts;
}

/**
 * 防御性解析 audit JSON：提取各严重级漏洞计数，解析失败返回 null。
 *
 * 真相源优先级（2026-10-25 修正，勿改回只读 metadata）：
 * 1. `advisories` 映射存在时以它为准 —— pnpm 会先把**已登记例外**从该映射剔除；
 * 2. 否则回退 `metadata.vulnerabilities`（npm 新版 JSON 无 advisories）。
 *
 * 为何不能只读 metadata：pnpm 11 的 `audit.ignore`（及已废弃的
 * `auditConfig.ignoreGhsas`）只过滤 `advisories`，**不修改 metadata**。
 * 实机基线（同一 lockfile，仅改 ignore 配置）：
 *   - 无 ignore → advisories=1 条、metadata.moderate=1、EXIT=1
 *   - 有 ignore → advisories=0 条、metadata.moderate=1、EXIT=0
 * 若此时仍读 metadata，就会在 pnpm 自己已判定「没有待处理漏洞」（EXIT=0）
 * 的情况下继续产出「发现 1 个 moderate 级依赖漏洞」，同一份数据给出互斥结论；
 * 该 issue 的 `file` 为空串 ⇒ `moduleOf('')` 落 `(root)` 桶 ⇒ 技术债面板
 * 持续再生伪债务项 `td-quality-44c4ce057952`，点开还没有对应文件。
 */
export function parseAuditVulnerabilities(raw: string): AuditVulnerabilities | null {
  try {
    const parsed = JSON.parse(raw) as {
      advisories?: unknown;
      metadata?: { vulnerabilities?: AuditVulnerabilities };
    };
    if (parsed.advisories && typeof parsed.advisories === 'object') {
      return countAdvisories(parsed.advisories as Record<string, AuditAdvisory>);
    }
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
