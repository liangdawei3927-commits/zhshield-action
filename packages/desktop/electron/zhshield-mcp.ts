import { readFileSync, existsSync } from 'node:fs';
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
import { persistDiagnosticsFromEntries } from './zh-diagnostics';
import type { DiagnosticEntry } from './zh-diagnostics';

const execFileAsync = promisify(execFile);
const server = new McpServer({ name: 'zhshield', version: '1.1.0' });

// ─── 辅助：读取 .zhshield 下的 JSON 文件 ────────────────────
function readZhshieldJson(root: string, relativePath: string): string {
  const filePath = join(root, '.zhshield', relativePath);
  if (!existsSync(filePath)) {
    return JSON.stringify({ ok: false, error: t('mcp.fileNotFound', { relativePath }) });
  }
  return readFileSync(filePath, 'utf-8');
}

// ─── 辅助：调用 zhshield CLI（自动探测 dist/src） ──────────
async function runCli(
  command: 'inspect' | 'guard' | 'refactor' | 'pipeline',
  projectPath: string,
  opts: { sop?: boolean; dryRun?: boolean } = {},
): Promise<string> {
  const cliDist = join(__dirname, '..', '..', 'cli', 'dist', 'index.js');
  const cliSrc = join(__dirname, '..', '..', 'cli', 'src', 'index.ts');
  // monorepo 根（node_modules 与本地 tsx 所在），npx 需在此目录解析本地工具
  const repoRoot = join(__dirname, '..', '..', '..');

  let cmd: string;
  let args: string[];
  let cwd: string;
  if (existsSync(cliDist)) {
    cmd = 'node';
    args = [cliDist, command, '--dir', projectPath];
    cwd = projectPath;
  } else if (existsSync(cliSrc)) {
    cmd = 'npx';
    // --no-install 且 cwd=repoRoot：强制使用 monorepo 本地 tsx，避免 npx 从
    // npm 缓存下载另一版本 tsx 导致 @zh/* workspace 包解析失败（MODULE_NOT_FOUND）
    args = ['--no-install', 'tsx', cliSrc, command, '--dir', projectPath];
    cwd = repoRoot;
  } else {
    return JSON.stringify({ ok: false, error: t('mcp.cliNotFound') });
  }
  if (opts.sop) args.push('--sop');
  if (opts.dryRun) args.push('--dry-run');

  try {
    const { stdout } = await execFileAsync(cmd, args, {
      // guard 的 TEST-001 会真实执行整套测试（冷缓存约 4 分钟），60s 超时会把
      // 尚未完成的检查整体杀死，导致诊断误报「未发现测试用例」
      timeout: 600_000,
      maxBuffer: 2 * 1024 * 1024,
      cwd,
      env: sanitizeEnv(),
    });
    return stdout || JSON.stringify({ ok: true, message: t('mcp.commandDoneNoOutput', { command }) });
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
    const text = readZhshieldJson(root, 'diagnostics/latest.json');
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
    source: z.enum(['guard', 'inspect', 'refactor']).optional().describe(t('mcp.sourceFilterDesc')),
  },
  async ({ projectPath, severity, category, source }) => {
    const root = projectPath ?? process.cwd();
    const text = readZhshieldJson(root, 'diagnostics/latest.json');
    let parsed: { issues?: ReadonlyArray<Record<string, unknown>> };
    try {
      parsed = JSON.parse(text);
    } catch {
      return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: t('mcp.diagnosticsUnparseable') }) }] };
    }
    let issues = parsed.issues ?? [];
    if (severity) issues = issues.filter((i) => i.severity === severity);
    if (category) issues = issues.filter((i) => i.category === category);
    if (source) issues = issues.filter((i) => i.source === source);
    return {
      content: [
        { type: 'text', text: JSON.stringify({ ok: true, total: issues.length, issues }) },
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
    const text = readZhshieldJson(root, 'integration.json');
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
          persistDiagnosticsFromEntries(projectPath, guardRecordToDiagnostics(records[0]));
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
  const message = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(`[zhshield-mcp] 启动失败: ${message}\n`);
  process.exitCode = 1;
});
