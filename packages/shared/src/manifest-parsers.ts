/**
 * 跨生态清单文件依赖名解析（manifest-parsers.ts）
 *
 * 背景：@zh/fingerprint 的 dep-parsers（读框架信号用）与 @zh/pipeline 的
 * project-profile（判 Python 画像用）各自实现过一份 pyproject.toml /
 * requirements.txt 的行解析与包名规范化 —— 正则、区段表与产出顺序逐字节相同。
 * 本模块把这份解析收敛为唯一来源，两域各自按需取用。
 *
 * 注：本包开启了 noUncheckedIndexedAccess，故正则捕获组与 split 首段统一经
 * capture()/leadingSegment() 取值；两者在「正则已匹配 / split 必有首段」的前提下
 * 与原实现 `x[1]` / `x[0]` 取值完全一致，不改变任何产出。
 */

/** 版本/环境标记分隔符（`<>=!~[;` 之前为包名） */
const VERSION_SPLIT_RE = /[<>=!~[;]/;

/** pyproject.toml 的区段头：`[project]` / `[tool.poetry.dependencies]` 等 */
const PYPROJECT_SECTION_RE = /^\[(.+)\]$/;

/** pyproject.toml 的键值行：`django = "^4.2"` */
const PYPROJECT_KEY_RE = /^([A-Za-z0-9_.-]+)\s*=/;

/** pyproject.toml 中声明依赖的区段（[project] 数组形式与各工具的子表形式） */
const PYPROJECT_DEP_SECTIONS: ReadonlySet<string> = new Set([
  'project',
  'project.dependencies',
  'tool.poetry.dependencies',
  'tool.uv.dependencies',
]);

/** 取正则首个捕获组；未参与匹配时回落空串（与原实现 `match[1]` 取值域一致） */
function capture(match: RegExpMatchArray | null): string {
  return match?.[1] ?? '';
}

/** 取分隔后首段（split 必有首段，`?? ''` 仅用于满足严格索引访问） */
function leadingSegment(value: string): string {
  return value.split(VERSION_SPLIT_RE)[0] ?? '';
}

/** 规范化包名：小写、`_` 与 `-` 等价，去掉版本/环境标记。 */
export function normalizePackageName(raw: string): string {
  return leadingSegment(raw).trim().toLowerCase().replace(/_/g, '-');
}

/**
 * 提取 pyproject.toml 中声明的依赖名。
 *
 * 键值形式（`django = "^4.2"`）与数组形式（`"django==4.2.0"`）都计入，
 * 仅在四个依赖区段内收集；产出顺序为行序。
 */
export function extractPyprojectDeps(content: string): string[] {
  const deps: string[] = [];
  let inDeps = false;
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    const header = line.match(PYPROJECT_SECTION_RE);
    if (header) {
      inDeps = PYPROJECT_DEP_SECTIONS.has(capture(header).trim());
      continue;
    }
    if (!inDeps) continue;
    const key = line.match(PYPROJECT_KEY_RE);
    if (key) deps.push(capture(key));
    for (const quoted of line.matchAll(/"([^"]+)"/g)) deps.push(capture(quoted));
  }
  return deps;
}

/** 提取 requirements.txt 的依赖名（跳过空行、注释行与 `-r`/`-e`/`--index-url` 等指令行）。 */
export function extractRequirementsNames(content: string): string[] {
  const names: string[] = [];
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('-')) continue;
    const name = leadingSegment(line).trim();
    if (name) names.push(name);
  }
  return names;
}
