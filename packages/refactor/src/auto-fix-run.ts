/**
 * 「一键应用自动修复」的执行编排（auto-fix-run.ts）。
 *
 * 从 RefactorEngine 抽出：只负责把已生成的修复**安全落盘**——越界过滤、写盘前备份、
 * 落盘后编译校验、引入新类型错误则整体回滚。与 engine 的扫描/生成职责解耦，
 * 也让引擎类保持在复杂度门禁（large-class / long-method）之内。
 *
 * 安全底线（代码审查报告3 P2-2 / P1-2）：
 * - 只写项目根内的目标；越界修复拒绝写入并计入 errors。
 * - 落盘前必先备份（可整目录回滚）。
 * - 落盘后编译校验；若引入新的类型错误则回滚，绝不把「一键修复」变成「一键改崩」。
 */
import * as fs from 'fs';
import type { Fix, RefactorAutoFixResult } from './types';
import { applyFixes } from './auto-fix';
import { backupFixTargets, isWithinProject, rollbackFixes } from './auto-fix-apply';
import { collectProjectErrors, newErrorsSince } from './auto-fix-verify';

/** 把修复拆成「项目根内可写」与「越界（拒绝写入，记入错误）」两部分。 */
function partitionInRoot(
  fixes: readonly Fix[],
  projectRoot: string,
): { safeFixes: Fix[]; outOfRootErrors: string[] } {
  const safeFixes: Fix[] = [];
  const outOfRootErrors: string[] = [];
  for (const fix of fixes) {
    const offending = fix.edits.find((e) => !isWithinProject(e.filePath, projectRoot));
    if (offending) {
      outOfRootErrors.push(`${offending.filePath}: 目标文件越出项目根，已拒绝写入`);
    } else {
      safeFixes.push(fix);
    }
  }
  return { safeFixes, outOfRootErrors };
}

export function applyGeneratedFixes(
  fixes: readonly Fix[],
  projectRoot: string,
): RefactorAutoFixResult {
  if (fixes.length === 0) {
    return {
      applied: false,
      fixCount: 0,
      smellCount: 0,
      fixed: 0,
      failed: 0,
      errors: [],
      backupDir: null,
      backedUpFiles: [],
      message:
        '没有可自动修复的问题（自动修复覆盖：封装性 inappropriate-intimacy、' +
        '回调地狱 callback-hell）',
    };
  }

  const { safeFixes, outOfRootErrors } = partitionInRoot(fixes, projectRoot);
  const targetFiles = [...new Set(safeFixes.flatMap((f) => f.edits.map((e) => e.filePath)))];
  const existingBefore = new Set(targetFiles.filter((fp) => fs.existsSync(fp)));
  // 落盘前抓编译校验基线；不可核验（无 tsconfig 等）时为 null → fail-open 沿用原行为。
  const errorsBefore = collectProjectErrors(projectRoot);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const { backupDir, backedUpFiles } = backupFixTargets(safeFixes, projectRoot, stamp);
  const result = applyFixes(safeFixes);
  const smellCount = new Set(safeFixes.map((f) => f.smellId)).size;

  // 落盘后复检：引入新类型错误 → 整体回滚（恢复备份 + 删除新建文件）。
  if (errorsBefore && result.fixed > 0) {
    const errorsAfter = collectProjectErrors(projectRoot);
    const introduced = errorsAfter ? newErrorsSince(errorsBefore, errorsAfter) : [];
    if (introduced.length > 0) {
      const createdFiles = targetFiles.filter((fp) => !existingBefore.has(fp));
      rollbackFixes(projectRoot, backupDir, backedUpFiles, createdFiles);
      return {
        applied: false,
        fixCount: safeFixes.length,
        smellCount,
        fixed: 0,
        failed: safeFixes.length + outOfRootErrors.length,
        errors: [
          ...outOfRootErrors,
          `编译校验发现自动修复会引入 ${introduced.length} 个类型错误，已整体回滚：`,
          ...introduced,
        ],
        backupDir,
        backedUpFiles,
      };
    }
  }

  return {
    applied: result.fixed > 0,
    fixCount: safeFixes.length,
    smellCount,
    fixed: result.fixed,
    failed: result.failed + outOfRootErrors.length,
    errors: [...outOfRootErrors, ...result.errors],
    backupDir,
    backedUpFiles,
  };
}
