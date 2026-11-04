/**
 * 「一键应用自动修复」的执行编排（auto-fix-run.ts）。
 *
 * 从 RefactorEngine 抽出：只负责把已生成的修复**安全落盘**——越界过滤、写盘前备份、
 * 落盘后编译校验、引入新类型错误则整体回滚。与 engine 的扫描/生成职责解耦，
 * 也让引擎类保持在复杂度门禁（large-class / long-method）之内。
 *
 * 安全底线（代码审查报告3 P2-2 / P1-2 / §5.5）：
 * - 只写项目根内的目标；越界修复拒绝写入并计入 errors。
 * - 落盘前必先备份，并把「备份了哪些文件、将新建哪些文件」写成清单落盘（可事后恢复）。
 * - **事务语义**：任何文件写入失败 / 落盘后编译校验引入新错 → 整体回滚，杜绝"修一半"。
 * - 回滚结果逐字节校验；校验/回滚本身失败必须如实上报（安全网自己失败是最坏的失败）。
 */
import type { Fix, FixResult, RefactorAutoFixResult } from './types';
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
  // 落盘前抓编译校验基线；不可核验（无 tsconfig 等）时为 null → fail-open 沿用原行为。
  const errorsBefore = collectProjectErrors(projectRoot);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const { backupDir, backedUpFiles, createdFiles } = backupFixTargets(safeFixes, projectRoot, stamp);
  const run: ApplyRun = {
    projectRoot,
    safeFixes,
    outOfRootErrors,
    smellCount: new Set(safeFixes.map((f) => f.smellId)).size,
    backupDir,
    backedUpFiles,
    createdFiles,
  };

  let result: FixResult;
  try {
    result = applyFixes(safeFixes);
  } catch (err) {
    // applyFixes 逐文件 catch，正常不抛；但"落盘编排"必须对任何异常都保持事务性
    return rollbackWithReport(
      run,
      [`写入过程中发生异常：${err instanceof Error ? err.message : String(err)}`],
      1,
    );
  }

  // 有文件写入失败（权限/磁盘满等）→ 整体回滚，杜绝"修一半"的中间态。
  if (result.failed > 0) {
    return rollbackWithReport(
      run,
      [`${result.failed} 个文件写入失败，已放弃本次修复以避免半改状态：`, ...result.errors],
      result.failed,
    );
  }

  // 落盘后复检：引入新类型错误 → 整体回滚（恢复备份 + 删除新建文件）。
  const rolledBack = rollbackIfNewTypeErrors(run, errorsBefore, result.fixed);
  if (rolledBack) return rolledBack;

  return {
    applied: result.fixed > 0,
    fixCount: safeFixes.length,
    smellCount: run.smellCount,
    fixed: result.fixed,
    failed: result.failed + outOfRootErrors.length,
    errors: [...outOfRootErrors, ...result.errors],
    backupDir,
    backedUpFiles,
  };
}

/** 一次落盘的上下文：备份、目标集合与分拣结果，供落盘/回滚/校验三段共享。 */
interface ApplyRun {
  projectRoot: string;
  safeFixes: readonly Fix[];
  outOfRootErrors: readonly string[];
  smellCount: number;
  backupDir: string | null;
  backedUpFiles: readonly string[];
  createdFiles: readonly string[];
}

/**
 * 事务语义：**要么全部应用，要么完全不应用**。
 *
 * 为什么不能"修一半"：一键修复的目的是让项目变好；半改之后项目可能仍能编译，但报告与
 * 代码状态不再对应 —— 用户既不知道改到哪一步，也无从判断要不要保留。对用户而言唯一
 * 可理解的状态只有两种：「没改动」或「全改好了（且有备份可撤销）」。
 *
 * 回滚失败必须如实上报（附备份目录），绝不把"改坏了且没复原"伪装成"已回滚"。
 */
function rollbackWithReport(
  run: ApplyRun,
  reason: string[],
  failedCount: number,
): RefactorAutoFixResult {
  const errors = [...run.outOfRootErrors, ...reason];
  let verified = true;
  try {
    rollbackFixes(run.projectRoot, run.backupDir, run.backedUpFiles, run.createdFiles);
  } catch (err) {
    verified = false;
    errors.push(
      `⚠️ 回滚未能完成：${err instanceof Error ? err.message : String(err)}；` +
        `备份仍保留在 ${run.backupDir ?? '(无)'}，请手工恢复`,
    );
  }
  errors.push(
    verified
      ? '已整体回滚：工作区恢复到本次修复前的状态（逐字节校验通过）'
      : '已尽力回滚，但校验未通过 —— 请以备份目录为准手工核对',
  );
  return {
    applied: false,
    fixCount: run.safeFixes.length,
    smellCount: run.smellCount,
    fixed: 0,
    failed: Math.max(failedCount, 1) + run.outOfRootErrors.length,
    errors,
    backupDir: run.backupDir,
    backedUpFiles: [...run.backedUpFiles],
  };
}

/** 落盘后编译校验；引入新类型错误则回滚并返回回滚结果，否则返回 null（无问题）。 */
function rollbackIfNewTypeErrors(
  run: ApplyRun,
  errorsBefore: ReadonlySet<string> | null,
  fixedCount: number,
): RefactorAutoFixResult | null {
  if (!errorsBefore || fixedCount === 0) return null;
  const errorsAfter = collectProjectErrors(run.projectRoot);
  const introduced = errorsAfter ? newErrorsSince(errorsBefore, errorsAfter) : [];
  if (introduced.length === 0) return null;
  return rollbackWithReport(
    run,
    [`编译校验发现自动修复会引入 ${introduced.length} 个类型错误，已整体回滚：`, ...introduced],
    1,
  );
}
