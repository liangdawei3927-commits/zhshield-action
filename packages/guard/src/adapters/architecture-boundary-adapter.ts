import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Adapter, CheckConfig, CheckResult, CheckStatus } from '../types';

/**
 * Layer boundary rules: which layers can import from which.
 * Based on clean architecture: domain ← application ← infrastructure ← presentation
 *
 * Lower index = more core (domain). A layer can import from same or lower index.
 */
const LAYER_RULES: { name: string; patterns: RegExp[]; index: number }[] = [
  { name: 'domain',       patterns: [/\/domain\//],                                                       index: 0 },
  { name: 'application',  patterns: [/\/application\//, /\/use-cases?\//, /\/usecases?\//],               index: 1 },
  { name: 'infrastructure', patterns: [/\/infrastructure\//, /\/data\//, /\/repositories?\//],            index: 2 },
  { name: 'presentation', patterns: [/\/presentation\//, /\/web\//, /\/api\//, /\/controllers?\//, /\/pages?\//], index: 3 },
];

const EXCLUDED_DIRS = new Set(['node_modules', 'dist', '.git', '.turbo', '.next', 'build', 'coverage']);

const TS_FILE_EXT = /\.(ts|tsx)$/;
const IMPORT_FROM = /import\s+.*\s+from\s+['"](\.\.?\/[^'"]+)['"]/;
const IMPORT_BARE = /import\s+['"](\.\.?\/[^'"]+)['"]/;

interface Violation {
  file: string;
  line: number;
  fromLayer: string;
  toLayer: string;
  importPath: string;
}

interface ResolveImportContext {
  line: string;
  lineNo: number;
  file: string;
  fromLayer: { name: string; index: number };
  targetDir: string;
}

function findLayer(filePath: string): { name: string; index: number } | null {
  for (const layer of LAYER_RULES) {
    for (const pattern of layer.patterns) {
      if (pattern.test(filePath)) return { name: layer.name, index: layer.index };
    }
  }
  return null;
}

function collectFiles(dir: string): string[] {
  const files: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch { return files; }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      files.push(...collectFiles(fullPath));
      continue;
    }
    if (TS_FILE_EXT.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

export class ArchitectureBoundaryAdapter implements Adapter {
  run(
    context: { repoRoot?: string; projectPath?: string },
    _check: CheckConfig,
  ): { violations: Violation[]; error?: string } {
    const targetDir = context.repoRoot || context.projectPath || process.cwd();
    const violations: Violation[] = [];

    try {
      this.scanProject(targetDir, violations);
    } catch (error: unknown) {
      return { violations: [], error: error instanceof Error ? error.message : String(error) };
    }

    return { violations };
  }

  /** 扫描项目的源码目录（无 src 时回退到项目根） */
  private scanProject(targetDir: string, violations: Violation[]): void {
    const srcDir = path.join(targetDir, 'src');
    const scanRoot = fs.existsSync(srcDir) ? srcDir : targetDir;
    const files = collectFiles(scanRoot);

    for (const file of files) {
      const fromLayer = findLayer(file);
      if (!fromLayer) continue;
      this.scanFileImports(file, fromLayer, targetDir, violations);
    }
  }

  private scanFileImports(
    file: string,
    fromLayer: { name: string; index: number },
    targetDir: string,
    violations: Violation[],
  ): void {
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf-8');
    } catch { return; }
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const violation = this.resolveImportViolation({
        line: lines[i],
        lineNo: i + 1,
        file,
        fromLayer,
        targetDir,
      });
      if (violation) violations.push(violation);
    }
  }

  private resolveImportViolation({
    line,
    lineNo,
    file,
    fromLayer,
    targetDir,
  }: ResolveImportContext): Violation | null {
    const importPath = this.extractImportPath(line);
    if (!importPath) return null;

    if (!importPath.startsWith('..') && !importPath.startsWith('./')) return null;

    const toLayer = this.resolveTargetLayer(file, importPath);
    if (!toLayer) return null;

    if (toLayer.index <= fromLayer.index) return null;

    return {
      file: path.relative(targetDir, file),
      line: lineNo,
      fromLayer: fromLayer.name,
      toLayer: toLayer.name,
      importPath,
    };
  }

  /** 从一行源码中提取 import 路径 */
  private extractImportPath(line: string): string | null {
    const importMatch = line.match(IMPORT_FROM) || line.match(IMPORT_BARE);
    return importMatch ? importMatch[1] : null;
  }

  /** 解析 import 路径对应的目标层 */
  private resolveTargetLayer(file: string, importPath: string): { name: string; index: number } | null {
    const resolved = path.resolve(path.dirname(file), importPath);
    return findLayer(resolved);
  }

  normalize(
    rawResult: { violations: Violation[]; error?: string },
    _context: unknown,
    check: CheckConfig,
  ): CheckResult {
    if (rawResult.error) {
      return this.makeResult(check, 'error', `模块边界检查失败: ${rawResult.error}`);
    }

    const violations = rawResult.violations;
    if (violations.length === 0) {
      return this.makeResult(check, 'passed', '模块边界检查通过，未发现跨层违规引用');
    }

    const details = violations.map(v =>
      `${v.file}:${v.line} [${v.fromLayer}→${v.toLayer}] ${v.importPath}`
    );
    return this.makeResult(
      check,
      'failed',
      `发现 ${violations.length} 处跨层违规引用:\n${details.join('\n')}`,
      { violations, count: violations.length },
    );
  }

  private makeResult(check: CheckConfig, status: CheckStatus, message: string, details?: unknown): CheckResult {
    return {
      checkId: check.checkId,
      adapter: check.adapter,
      status,
      severity: status === 'failed' || status === 'error' ? check.severity : 'info',
      blocking: check.blocking && (status === 'failed' || status === 'error'),
      message,
      details,
    };
  }
}
