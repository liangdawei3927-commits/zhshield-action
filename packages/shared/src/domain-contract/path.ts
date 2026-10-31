/**
 * 路径归一化（《07-十域职责边界与独立性契约》§5「路径归一化」）。
 *
 * 背景（2026-10-31 实测 P1）：`zh-diagnostics-esloc.ts` 用
 * `` `file://${join(project.path, issue.file)}` `` 拼 URI，而 `issue.file` 本身
 * 已是绝对路径，于是产出 `file:///tmp/p/tmp/p/src/a.ts` 这种双拼 URI，
 * 前端跳转全部 404。
 *
 * 唯一口径：
 *   · 落盘/存储 → `toRelativePath(projectRoot, file)`，一律相对 projectRoot
 *   · 展示/跳转 → `toFileUri(projectRoot, file)`，只在此处拼一次 `file://`
 */
import { isAbsolute, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

/** 绝对路径还原：相对路径按 projectRoot 拼绝对；绝对路径原样返回 */
export function toAbsolutePath(projectRoot: string, file: string): string {
  return isAbsolute(file) ? file : join(projectRoot, file);
}

/**
 * 归一化为相对 projectRoot 的路径（落盘与 Issue.file 的唯一合法形态）。
 *
 * 已经是相对路径时原样归一化分隔符；绝对路径则求相对值，避免把绝对路径写进 Issue。
 */
export function toRelativePath(projectRoot: string, file: string): string {
  if (file === '') return file;
  if (!isAbsolute(file)) return sep === '/' ? file : file.split(sep).join('/');
  const rel = relative(projectRoot, file);
  return sep === '/' ? rel : rel.split(sep).join('/');
}

/**
 * 生成展示用 `file://` URI（LSP / 前端跳转的唯一入口）。
 *
 * 直接用 `pathToFileURL` 而不是字符串拼接：它会正确处理空格、`#`、中文等需要
 * 百分号编码的字符，也不会因为「已是绝对路径」再拼一次 projectRoot。
 */
export function toFileUri(projectRoot: string, file: string): string {
  return pathToFileURL(toAbsolutePath(projectRoot, file)).href;
}
