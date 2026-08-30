import * as fs from 'fs';
import { safeJoin } from '@zh/shared';

/** 项目运行命令识别结果 */
export interface DetectedRunCommand {
  /** package.json 中命中的脚本名（dev / start / build 等） */
  script: string;
  /** 完整执行命令（npm run <script>） */
  command: string;
}

/** 脚本优先级：越靠前越可能是用户日常运行的目标 */
const SCRIPT_PRIORITY = ['dev', 'start', 'build', 'serve', 'preview', 'debug'];

/** 解析 package.json 内容，识别最可能的运行命令；无 package.json 或无 scripts 时返回 null */
export function parseRunCommand(packageJson: string): DetectedRunCommand | null {
  let pkg: { scripts?: Record<string, string> };
  try {
    pkg = JSON.parse(packageJson) as { scripts?: Record<string, string> };
  } catch {
    return null;
  }
  if (!pkg.scripts) return null;

  for (const script of SCRIPT_PRIORITY) {
    if (typeof pkg.scripts[script] === 'string' && pkg.scripts[script].trim().length > 0) {
      return { script, command: `npm run ${script}` };
    }
  }
  return null;
}

/** 读取项目 package.json 并识别运行命令 */
export function detectRunCommand(projectPath: string): DetectedRunCommand | null {
  const pkgPath = safeJoin(projectPath, 'package.json');
  if (!fs.existsSync(pkgPath)) return null;
  try {
    return parseRunCommand(fs.readFileSync(pkgPath, 'utf-8'));
  } catch {
    return null;
  }
}

/** 扫描项目内常见日志位置（logs/ 目录 + 根目录 *.log），按 mtime 倒序，最多返回 limit 条 */
export function discoverLogPaths(projectPath: string, limit = 20): string[] {
  const candidates: Array<{ file: string; mtimeMs: number }> = [];
  collectLogCandidates(safeJoin(projectPath, 'logs'), '.log', candidates);
  collectLogCandidates(projectPath, '.log', candidates);
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates.slice(0, limit).map((c) => c.file);
}

/** 收集目录内匹配扩展名的日志文件（记录 mtime 供排序） */
function collectLogCandidates(dir: string, extension: string, candidates: Array<{ file: string; mtimeMs: number }>): void {
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(extension)) continue;
    const file = safeJoin(dir, entry.name);
    try {
      candidates.push({ file, mtimeMs: fs.statSync(file).mtimeMs });
    } catch {
      // 文件可能被占用或刚被轮转删除
    }
  }
}
