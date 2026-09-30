import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Adapter, CheckConfig, CheckResult } from '../types';
import { makeAdapterResult, resolveScanTargetDir, toErrorMessage } from './adapter-result';
import { collectSourceFiles } from './source-files';
import { detectLayer, detectLayerByName } from '@zh/kernel';
import {
  ARCH_LAYER_EXCLUDE_PATTERNS,
  ARCH_LAYER_EXCLUDED_DIRS,
  CLEAN_ARCH_LAYERS,
  isLayerDependencyAllowed,
  matchGlobPath,
} from '@zh/shared';

/**
 * 门禁侧架构分层适配器（ARCH-001）
 *
 * T8 口径统一：层级定义与层判定语义**不再自持**——
 * - 层级表取自 `@zh/shared` 的 `CLEAN_ARCH_LAYERS`（与体检的
 *   `inspect/scan/architecture/layer-boundary.yml` 逐字同源）；
 * - 层判定复用 `@zh/kernel` 的 `detectLayer` / `detectLayerByName`
 *   （与内核 layer-boundary 内联评估器同一实现）。
 *
 * 历史实现自持一份 4 层 rank 模型（domain←application←infrastructure←presentation，
 * 违反条件为「内层引用外层」），与体检的 7 层 allowlist 模型对同一处违规结论不同：
 * 层名不匹配（services / adapters / shared 三层的文件旧实现直接跳过）、
 * 判定语义相反（rank 比较 vs 白名单）。现统一为 allowlist 语义。
 *
 * 契约不变：run() 返回 { violations, error? }，violation 形状保持兼容。
 */
const SCAN_FILE_EXT = /\.(ts|tsx|js|jsx)$/;

/** 与内核 layer-boundary 内联评估器同款导入捕获（含 require 与一行多条 import） */
const IMPORT_REGEX =
  /(?:import\s+(?:[\w*{},\s]+\s+from\s+)?['"])([^'"]+)(?:['"])|(?:require\s*\(\s*['"])([^'"]+)(?:['"]\s*\))/g;

interface Violation {
  file: string;
  line: number;
  fromLayer: string;
  toLayer: string;
  importPath: string;
}

/** 扫描上下文：目标目录 + 其下的相对路径基准 */
interface ScanContext {
  rootDir: string;
  scanRoot: string;
}

export class ArchitectureBoundaryAdapter implements Adapter {
  run(
    context: { repoRoot?: string; projectPath?: string },
    _check: CheckConfig,
  ): { violations: Violation[]; error?: string } {
    const targetDir = resolveScanTargetDir(context, _check.checkId);
    const violations: Violation[] = [];

    try {
      this.scanProject(targetDir, violations);
    } catch (error: unknown) {
      return { violations: [], error: toErrorMessage(error) };
    }

    return { violations };
  }

  /** 扫描项目的源码目录（无 src 时回退到项目根） */
  private scanProject(targetDir: string, violations: Violation[]): void {
    const srcDir = path.join(targetDir, 'src');
    const scanRoot = fs.existsSync(srcDir) ? srcDir : targetDir;
    const ctx: ScanContext = { rootDir: targetDir, scanRoot };

    for (const file of collectSourceFiles(
      scanRoot,
      (name) => ARCH_LAYER_EXCLUDED_DIRS.includes(name),
      (name) => SCAN_FILE_EXT.test(name) && !name.endsWith('.d.ts'),
    )) {
      const relativePath = path.relative(ctx.rootDir, file).replace(/\\/g, '/');
      if (this.isExcludedPath(relativePath)) continue;
      // 层判定按目录名进行；未命中任何层名的文件不产生结论（不误报）
      const fromLayer = detectLayer(relativePath, CLEAN_ARCH_LAYERS);
      if (!fromLayer) continue;
      this.scanFileImports(file, relativePath, fromLayer, violations);
    }
  }

  /** 测试/声明/产物文件不参与层判定（与规则 YAML 的 excludePatterns 对齐） */
  private isExcludedPath(relativePath: string): boolean {
    // 复用 @zh/shared 的 glob 实现，避免自持一套匹配语义
    return ARCH_LAYER_EXCLUDE_PATTERNS.some((pattern) => matchGlobPath(relativePath, pattern));
  }

  private scanFileImports(
    file: string,
    relativePath: string,
    fromLayer: string,
    violations: Violation[],
  ): void {
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf-8');
    } catch {
      return;
    }

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      IMPORT_REGEX.lastIndex = 0;
      let match: RegExpExecArray | null;
      // 一行可能有多条 import，逐条检查（与内核评估器一致）
      while ((match = IMPORT_REGEX.exec(lines[i])) !== null) {
        const importPath = match[1] || match[2] || '';
        if (!importPath) continue;
        // 传完整导入路径：相对导入与路径别名都能按目录段识别层
        const toLayer = detectLayerByName(importPath, CLEAN_ARCH_LAYERS);
        if (!toLayer || toLayer === fromLayer) continue;
        if (isLayerDependencyAllowed(fromLayer, toLayer, CLEAN_ARCH_LAYERS)) continue;
        violations.push({ file: relativePath, line: i + 1, fromLayer, toLayer, importPath });
      }
    }
  }

  normalize(
    rawResult: { violations: Violation[]; error?: string },
    _context: unknown,
    check: CheckConfig,
  ): CheckResult {
    if (rawResult.error) {
      return makeAdapterResult(check, 'error', `模块边界检查失败: ${rawResult.error}`);
    }

    const violations = rawResult.violations;
    if (violations.length === 0) {
      return makeAdapterResult(check, 'passed', '模块边界检查通过，未发现跨层违规引用');
    }

    const details = violations.map(
      (v) => `${v.file}:${v.line} [${v.fromLayer}→${v.toLayer}] ${v.importPath}`,
    );
    return makeAdapterResult(
      check,
      'failed',
      `发现 ${violations.length} 处跨层违规引用:\n${details.join('\n')}`,
      { violations, count: violations.length },
    );
  }
}
