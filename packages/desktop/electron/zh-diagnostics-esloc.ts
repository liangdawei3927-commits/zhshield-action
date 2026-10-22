import { readFile, readdir } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import type {
  DiagnosticEntry,
  DiagnosticsReport,
  LspDiagnostic,
  DiagnosticSeverity,
} from './zh-diagnostics-types';

// ─── 汇总 + LSP 视图 ───────────────────────────────────────────────────

export function buildDiagnosticsReport(
  project: { path: string; name: string },
  issues: readonly DiagnosticEntry[],
  generatedAt: string,
): DiagnosticsReport {
  const byFile = new Map<string, LspDiagnostic[]>();
  for (const issue of issues) {
    if (!issue.file) continue;
    const uri = `file://${join(project.path, issue.file)}`;
    const list = byFile.get(uri) ?? [];
    list.push(toLspDiagnostic(issue));
    byFile.set(uri, list);
  }
  return {
    version: '1.0',
    project,
    generatedAt,
    summary: {
      total: issues.length,
      error: issues.filter((i) => i.severity === 'error').length,
      warning: issues.filter((i) => i.severity === 'warning').length,
      info: issues.filter((i) => i.severity === 'info').length,
    },
    issues,
    files: Array.from(byFile.entries(), ([uri, diagnostics]) => ({ uri, diagnostics })),
  };
}

function toLspDiagnostic(issue: DiagnosticEntry): LspDiagnostic {
  // 协议：0-based 行列号，单字符 span（start = 起点，end = 起点 + 1）
  const line = (issue.line ?? 1) - 1;
  const character = (issue.column ?? 1) - 1;
  const data: LspDiagnostic['data'] = {
    category: issue.category,
    autoFixable: issue.autoFixable,
    ...(issue.suggestion ? { suggestion: issue.suggestion } : {}),
  };
  return {
    range: { start: { line, character }, end: { line, character: character + 1 } },
    severity: mapLspSeverity(issue.severity),
    code: issue.ruleId,
    source: 'zhshield',
    message: issue.message,
    data,
  };
}

function mapLspSeverity(severity: DiagnosticSeverity): LspDiagnostic['severity'] {
  switch (severity) {
    case 'error':
      return 1;
    case 'warning':
      return 2;
    case 'info':
      return 3;
    default:
      return assertNever(severity);
  }
}

function assertNever(value: never): never {
  throw new Error(`unreachable severity: ${String(value)}`);
}

// ─── ESLOC（S2 密度归一化的规模分母） ───────────────────────────────────

/** ESLOC 口径：TS 系源码文件的非空行合计（S2 章程修正②的密度因子分母）。 */
const ESLOC_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);
const ESLOC_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'dist-electron', 'build', 'coverage', 'generated', '.turbo', '.next', '.cache']);
const ESLOC_TEST_DIR_RE = /^(test|tests|__tests__|spec|e2e)$/i;
const ESLOC_TEST_FILE_RE = /\.(test|spec)\.[^.]+$/;

function isEslocTestFile(relPath: string): boolean {
  const segments = relPath.split(sep);
  if (segments.some((s) => ESLOC_TEST_DIR_RE.test(s))) return true;
  return ESLOC_TEST_FILE_RE.test(relPath);
}

/** 读取目录条目；目录不可读返回 null（调用方整体跳过该目录，不抛错） */
async function readEslocDir(dir: string): Promise<Dirent[] | null> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
}

/** 单文件非空行计数（ESLOC 口径：trim 后非空即计 1 行）；读取失败由调用方跳过 */
async function countLinesInFile(fullPath: string): Promise<number> {
  const content = await readFile(fullPath, 'utf-8');
  let count = 0;
  for (const line of content.split('\n')) {
    if (line.trim().length > 0) count += 1;
  }
  return count;
}

/** 单个目录条目处理：目录入队 / 源文件计入 ESLOC，返回该条目的行数贡献；跳过目录/文件读取失败返回 0 */
async function collectEslocEntry(
  projectPath: string,
  dir: string,
  entry: Dirent,
  pending: string[],
): Promise<number> {
  const full = join(dir, entry.name);
  if (entry.isDirectory()) {
    if (!ESLOC_SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) pending.push(full);
    return 0;
  }
  if (!entry.isFile()) return 0;
  const ext = extname(entry.name);
  if (!ESLOC_EXTENSIONS.has(ext)) return 0;
  const rel = relative(projectPath, full);
  if (isEslocTestFile(rel)) return 0;
  try {
    return await countLinesInFile(full);
  } catch {
    // 单文件读取失败不影响整体统计
    return 0;
  }
}

/** 统计项目源文件 ESLOC（非空行数）。目录不可读/文件损坏时跳过该条，不抛错。 */
export async function countSourceEsloc(projectPath: string): Promise<number> {
  let total = 0;
  const pending = [projectPath];
  while (pending.length > 0) {
    const dir = pending.pop() as string;
    const entries = await readEslocDir(dir);
    if (entries === null) continue;
    for (const entry of entries) {
      total += await collectEslocEntry(projectPath, dir, entry, pending);
    }
  }
  return total;
}
