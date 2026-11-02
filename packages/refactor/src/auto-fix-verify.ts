/**
 * 自动修复的「编译校验-回滚」支撑（auto-fix-verify.ts）。
 *
 * 背景（代码审查报告3 P1-2 / §7.3 方案①）：`inappropriate-intimacy` 自动修复会把
 * public 字段改为 private；若该字段被项目内其它文件以 `obj.field` 访问，改动会让
 * 调用方编译报错。维护者测试显式断言该改写行为，故不贸然移除；改为在落盘后用
 * TypeScript 编译器 API 复检：若引入新的类型错误则整体回滚，把「不破坏用户编译」
 * 从口头承诺变成可验证不变量。
 *
 * 设计：fail-open（无 tsconfig/解析失败/文件过多/异常 → null）；诊断键不含行列
 * （避免编辑造成行/列漂移被误判新增）；覆盖整个项目程序（断链错误在引用方文件）。
 */
import * as path from 'path';
import * as ts from 'typescript';

/** 单次可核验的项目文件数上限：超过则跳过（避免一次性全量类型检查卡死 / OOM）。 */
const MAX_VERIFY_FILES = 1500;

/**
 * 收集项目当前所有「错误」级诊断的归一化键集合。
 * 无法构建程序时返回 null（调用方 fail-open，沿用原落盘行为）。
 */
export function collectProjectErrors(projectRoot: string): Set<string> | null {
  try {
    const configPath = ts.findConfigFile(projectRoot, ts.sys.fileExists, 'tsconfig.json');
    if (!configPath) return null;

    const read = ts.readConfigFile(configPath, ts.sys.readFile);
    if (read.error) return null;

    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(configPath));
    // 排除注入的备份副本与构建产物，避免其参与类型检查导致「自造重复符号」等假阳性
    // （备份位于 .zhshield/backups，若被用户 tsconfig 的宽 include 捎带会引入重复类）。
    const rootNames = parsed.fileNames.filter(
      (fn) =>
        !fn.includes(`${path.sep}.zhshield${path.sep}`) &&
        !fn.includes(`${path.sep}node_modules${path.sep}`) &&
        !fn.includes(`${path.sep}dist${path.sep}`),
    );
    if (rootNames.length === 0 || rootNames.length > MAX_VERIFY_FILES) return null;

    const program = ts.createProgram({
      rootNames,
      // skipLibCheck：只对用户源码做类型检查，跳过 .d.ts（标准库 / @types）的类型检查，
      // 这是 tsc --skipLibCheck 的标准提速手段，不影响 .ts 源码里的错误检出。
      options: { ...parsed.options, noEmit: true, skipLibCheck: true },
    });

    const diags = [...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics()];
    const errors = new Set<string>();
    for (const d of diags) {
      if (d.category !== ts.DiagnosticCategory.Error) continue;
      const file = d.file ? path.relative(projectRoot, d.file.fileName) : '<global>';
      errors.add(`${file}::${d.code}::${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
    }
    return errors;
  } catch {
    return null;
  }
}

/** 计算 after 相对 before 的「新增」错误（语义差异，与顺序无关）。 */
export function newErrorsSince(before: ReadonlySet<string>, after: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const e of after) {
    if (!before.has(e)) out.push(e);
  }
  return out;
}
