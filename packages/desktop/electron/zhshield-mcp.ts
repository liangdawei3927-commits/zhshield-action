import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { t } from '@zh/i18n';
import { sanitizeEnv } from '@zh/shared';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { listGuardReports } from '@zh/guard';
import type { GuardReportRecord } from '@zh/guard';
import { persistDiagnosticsFromEntries, readAggregatedDiagnostics } from './zh-diagnostics';
import type { DiagnosticEntry } from './zh-diagnostics';

const execFileAsync = promisify(execFile);
const server = new McpServer({ name: 'zhshield', version: '1.1.0' });

// ─── 辅助：读取 .zhshield 下的 JSON 文件 ────────────────────
async function readZhshieldJson(root: string, relativePath: string): Promise<string> {
  const filePath = join(root, '.zhshield', relativePath);
  try {
    const text = await readFile(filePath, 'utf-8');
    // 空文件（如未配置的 integration.json）返回结构化错误，避免调用方拿到非法 JSON
    if (text.trim() === '') {
      return JSON.stringify({ ok: false, error: t('mcp.emptyFile', { relativePath }) });
    }
    return text;
  } catch {
    return JSON.stringify({ ok: false, error: t('mcp.fileNotFound', { relativePath }) });
  }
}

// ─── 辅助：静默读取 .zhshield 下的 JSON 文件（缺失返回 null） ──
async function tryReadZhshieldJson(root: string, relativePath: string): Promise<string | null> {
  try {
    return await readFile(join(root, '.zhshield', relativePath), 'utf-8');
  } catch {
    return null;
  }
}

// ─── 辅助：诊断读取（含首次引导） ──────────────────────────
// AI 工具接入全新项目的常态是目标项目从未做过体检（无 latest.json）。
// 直接返回 fileNotFound 会让调用方一无所获——首次引导自动触发一次巡检，
// 保证冷启动调用必有结果。巡检后仍无 latest.json（该文件是桌面端专属
// 缓存，CLI 不落盘），则回退读取 CLI 写出的巡检报告 zhshield.json。
interface DiagnosticsRead {
  text: string;
  bootstrapped: boolean;
}

/** 聚合各域快照：latest.json 只保留最后写入的引擎结果，直读会丢失其他域 */
async function aggregateDiagnostics(root: string, text: string): Promise<string> {
  try {
    const parsed = JSON.parse(text) as { issues?: unknown };
    // 首次引导的回退包装形态没有 issues 数组，保持原样
    if (!Array.isArray(parsed.issues)) return text;
  } catch {
    return text;
  }
  const aggregated = await readAggregatedDiagnostics(root);
  return aggregated ? JSON.stringify(aggregated) : text;
}

async function readDiagnosticsWithBootstrap(root: string): Promise<DiagnosticsRead> {
  const existing = await tryReadZhshieldJson(root, 'diagnostics/latest.json');
  if (existing !== null) {
    return { text: await aggregateDiagnostics(root, existing), bootstrapped: false };
  }

  // --format json：CLI 仅在 json 格式下落盘巡检报告 zhshield.json，
  // text 格式只打印不写文件，首次引导将拿不到任何持久化结果
  await runCli('inspect', root, { format: 'json' });

  const afterScan = await tryReadZhshieldJson(root, 'diagnostics/latest.json');
  if (afterScan !== null) {
    return { text: await aggregateDiagnostics(root, afterScan), bootstrapped: true };
  }

  try {
    const report = await readFile(join(root, 'zhshield.json'), 'utf-8');
    return {
      text: JSON.stringify({
        ok: true,
        bootstrapped: true,
        note: t('mcp.bootstrapReportFallback'),
        report: JSON.parse(report),
      }),
      bootstrapped: true,
    };
  } catch {
    return {
      text: JSON.stringify({
        ok: false,
        bootstrapped: true,
        error: t('mcp.fileNotFound', { relativePath: 'diagnostics/latest.json' }),
      }),
      bootstrapped: true,
    };
  }
}

// ─── 辅助：toolError 与 finding 分离 ───────────────────────
// ruleId 含 `.external.` 的条目来自外部工具执行（trivy/依赖审计等），
// 内容是工具运行状态乃至报错原文（如 trivy FATAL），不是代码发现；
// 混入 issues 会污染 AI 的输入信号，故单独归入 toolErrors 通道。
// 结构化分离的完整方案在 Tool Registry 落地后收口（阶段 3.3）。
function isToolErrorEntry(issue: Record<string, unknown>): boolean {
  return typeof issue.ruleId === 'string' && issue.ruleId.includes('.external.');
}

// ─── 辅助：issues 排序与截断 ────────────────────────────────
// 大型项目一次体检可产生数百条条目（如 refactor 结构性异味），全量返回会
// 占用 AI 上下文并挤掉用户自己的代码，故默认只返回 severity 最高的若干条。
const DEFAULT_ISSUE_LIMIT = 50;
const SEVERITY_RANK: Readonly<Record<string, number>> = { error: 0, warning: 1, info: 2 };

function severityRank(issue: Record<string, unknown>): number {
  return typeof issue.severity === 'string' ? (SEVERITY_RANK[issue.severity] ?? 3) : 3;
}

// ─── 辅助：探测 zhshield CLI 启动方式（dist 优先，否则 src + 本地 tsx） ──
interface CliInvocation {
  cmd: string;
  args: string[];
  cwd: string;
}

async function resolveCliInvocation(
  command: 'inspect' | 'guard' | 'refactor' | 'pipeline',
  projectPath: string,
): Promise<CliInvocation | null> {
  const cliDist = join(__dirname, '..', '..', 'cli', 'dist', 'index.js');
  const cliSrc = join(__dirname, '..', '..', 'cli', 'src', 'index.ts');
  // monorepo 根（node_modules 与本地 tsx 所在），npx 需在此目录解析本地工具
  const repoRoot = join(__dirname, '..', '..', '..');

  try {
    await access(cliDist);
    return { cmd: 'node', args: [cliDist, command, '--dir', projectPath], cwd: projectPath };
  } catch {
    // dist 不存在，回退到 src + 本地 tsx
  }
  try {
    await access(cliSrc);
    // --no-install 且 cwd=repoRoot：强制使用 monorepo 本地 tsx，避免 npx 从
    // npm 缓存下载另一版本 tsx 导致 @zh/* workspace 包解析失败（MODULE_NOT_FOUND）
    return {
      cmd: 'npx',
      args: ['--no-install', 'tsx', cliSrc, command, '--dir', projectPath],
      cwd: repoRoot,
    };
  } catch {
    return null;
  }
}

// ─── 辅助：调用 zhshield CLI（自动探测 dist/src） ──────────
async function runCli(
  command: 'inspect' | 'guard' | 'refactor' | 'pipeline',
  projectPath: string,
  opts: { sop?: boolean; dryRun?: boolean; format?: 'json' | 'text' } = {},
): Promise<string> {
  const invocation = await resolveCliInvocation(command, projectPath);
  if (!invocation) {
    return JSON.stringify({ ok: false, error: t('mcp.cliNotFound') });
  }

  const args = [...invocation.args];
  if (opts.sop) args.push('--sop');
  if (opts.dryRun) args.push('--dry-run');
  if (opts.format) args.push('--format', opts.format);

  try {
    const { stdout } = await execFileAsync(invocation.cmd, args, {
      // guard 的 TEST-001 会真实执行整套测试（冷缓存约 4 分钟），60s 超时会把
      // 尚未完成的检查整体杀死，导致诊断误报「未发现测试用例」
      timeout: 600_000,
      maxBuffer: 2 * 1024 * 1024,
      cwd: invocation.cwd,
      env: sanitizeEnv(),
    });
    return (
      stdout || JSON.stringify({ ok: true, message: t('mcp.commandDoneNoOutput', { command }) })
    );
  } catch (err) {
    const output =
      err && typeof err === 'object' && 'stdout' in err
        ? String((err as { stdout: unknown }).stdout)
        : err instanceof Error
          ? err.message
          : String(err);
    return JSON.stringify({ ok: false, error: t('mcp.commandFailed', { command }), output });
  }
}

// ─── 工具 1：读取体检诊断 ──────────────────────────────────
server.tool(
  'getDiagnostics',
  t('mcp.getDiagnosticsDesc'),
  { projectPath: z.string().optional().describe(t('mcp.projectPathDesc')) },
  async ({ projectPath }) => {
    const root = projectPath ?? process.cwd();
    const { text } = await readDiagnosticsWithBootstrap(root);
    return { content: [{ type: 'text', text }] };
  },
);

// ─── 工具 1b：按条件过滤 issues（便于 Trae/AI 精准取数） ────
server.tool(
  'getIssues',
  t('mcp.getIssuesDesc'),
  {
    projectPath: z.string().optional().describe(t('mcp.projectPathDesc')),
    severity: z.enum(['error', 'warning', 'info']).optional().describe(t('mcp.severityFilterDesc')),
    category: z.string().optional().describe(t('mcp.categoryFilterDesc')),
    source: z
      .enum(['guard', 'inspect', 'refactor', 'deps', 'techdebt', 'security', 'performance'])
      .optional()
      .describe(t('mcp.sourceFilterDesc')),
    limit: z.number().int().min(1).max(500).optional().describe(t('mcp.limitDesc')),
  },
  async ({ projectPath, severity, category, source, limit }) => {
    const root = projectPath ?? process.cwd();
    const { text } = await readDiagnosticsWithBootstrap(root);
    let parsed: {
      issues?: ReadonlyArray<Record<string, unknown>>;
      report?: Record<string, unknown>;
    };
    try {
      parsed = JSON.parse(text);
    } catch {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ok: false, error: t('mcp.diagnosticsUnparseable') }),
          },
        ],
      };
    }
    // 首次引导的回退形态：无 latest.json 时返回的是巡检报告包装，没有 issues 数组
    if (!Array.isArray(parsed.issues)) {
      return { content: [{ type: 'text', text }] };
    }
    // toolError 与 finding 分离：外部工具执行条目不进入 issues 主列表
    const toolErrors = parsed.issues.filter(isToolErrorEntry);
    let issues = parsed.issues.filter((i) => !isToolErrorEntry(i));
    if (severity) issues = issues.filter((i) => i.severity === severity);
    if (category) issues = issues.filter((i) => i.category === category);
    if (source) issues = issues.filter((i) => i.source === source);
    // error 优先、其次 warning、最后 info；toSorted 复制后排序（不改原数组），同等级保持原顺序（稳定排序）
    issues = issues.toSorted((a, b) => severityRank(a) - severityRank(b));
    const total = issues.length;
    const capped = limit ?? DEFAULT_ISSUE_LIMIT;
    const truncated = total > capped;
    if (truncated) issues = issues.slice(0, capped);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ok: true,
            total,
            returned: issues.length,
            truncated,
            issues,
            toolErrors: { count: toolErrors.length, note: t('mcp.toolErrorsNote'), items: toolErrors },
          }),
        },
      ],
    };
  },
);

// ─── 工具 2：读取集成配置 ──────────────────────────────────
server.tool(
  'getIntegration',
  t('mcp.getIntegrationDesc'),
  { projectPath: z.string().optional().describe(t('mcp.projectPathDesc')) },
  async ({ projectPath }) => {
    const root = projectPath ?? process.cwd();
    const text = await readZhshieldJson(root, 'integration.json');
    return { content: [{ type: 'text', text }] };
  },
);

// ─── 工具 3：触发巡检 ──────────────────────────────────────
server.tool(
  'runInspect',
  t('mcp.runInspectDesc'),
  {
    projectPath: z.string().describe(t('mcp.inspectProjectPathDesc')),
    sop: z.boolean().optional().describe(t('mcp.sopModeDesc')),
  },
  async ({ projectPath, sop }) => {
    const text = await runCli('inspect', projectPath, { sop });
    return { content: [{ type: 'text', text }] };
  },
);

// ─── 辅助：guard 记录 → 诊断条目（与桌面 IPC normalizeGuardSource 同一语义） ──
function guardRecordToDiagnostics(record: GuardReportRecord): DiagnosticEntry[] {
  return record.checks
    .filter((check) => check.status !== 'passed')
    .map((check) => ({
      ruleId: check.checkId,
      severity: check.severity,
      category: 'quality',
      message: check.message,
      file: '',
      autoFixable: false,
      source: 'guard' as const,
      fingerprint: `${check.checkId}:${check.adapter}:0`,
    }));
}

// ─── 工具 4：触发门禁检查（dry-run 只报告不阻断） ──────────
server.tool(
  'runGuard',
  t('mcp.runGuardDesc'),
  {
    projectPath: z.string().describe(t('mcp.guardProjectPathDesc')),
    sop: z.boolean().optional().describe(t('mcp.guardSopModeDesc')),
  },
  async ({ projectPath, sop }) => {
    const text = await runCli('guard', projectPath, { sop, dryRun: true });
    // 检查完成后落盘诊断：CLI 已写入 guard-reports.jsonl（非 SOP 模式），
    // 同步更新 latest.json，保证 getDiagnostics 反映最新门禁结果而非上次体检
    if (!sop) {
      try {
        const records = listGuardReports(projectPath, 1);
        if (records.length > 0) {
          await persistDiagnosticsFromEntries(projectPath, guardRecordToDiagnostics(records[0]), [
            'guard',
          ]);
        }
      } catch (e) {
        console.warn('[zhshield-mcp] 诊断落盘失败:', e instanceof Error ? e.message : String(e));
      }
    }
    return { content: [{ type: 'text', text }] };
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`[zhshield-mcp] 启动失败: ${message}\n`);
  process.exitCode = 1;
});
