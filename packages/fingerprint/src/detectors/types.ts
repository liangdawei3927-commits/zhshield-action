// Detector 共享助手：信号构造、目录形态信号、依赖名解析。

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Signal, ProductFormId } from '../types';
import { FORM_DIR_RULES, slugify } from '../language-map';
import { isNoiseDir, isRecord } from '../fs-utils';
import {
  normalizePackageName,
  extractPyprojectDeps,
  extractRequirementsNames,
  extractPomDependencies,
  extractGoModRequires,
  extractCargoDeps,
  extractComposerRequire,
  extractGemfileDeps,
} from './dep-parsers';

/**
 * 构造信号（ruleId/kind/file/weight/payload；weight = 产出探测器的权重）。
 *
 * 参数即信号本体：此前另立了同形参数类型 `MakeSignalParams`，与 {@link Signal}
 * 的 5 个字段逐一重复且注释各写一份 —— `Signal` 加字段时它不会跟随，等于给
 * 信号形状开了第二个定义点。现直接用 `Signal` 约束入参。
 */
export function makeSignal(signal: Signal): Signal {
  return signal;
}

/**
 * 信号列表的稳定排序：先按 ruleId，再按 file。
 *
 * 为什么必须共享：五个探测器各自写了同一行三元嵌套比较器，产出顺序是
 * 画像指纹的一部分（同一项目两次扫描必须逐条一致，否则 diff 噪声会掩盖真实变化）。
 * 各写一份时，任何一处补规则（例如加了 file 次序）都会让该探测器与其他四处的
 * 排序口径分叉，表现为「同样的输入，换个探测器聚合顺序就变」。
 *
 * 注意：这是**就地排序**并返回原数组（调用方一直是 `return signals.sort(...)` 的用法）。
 */
export function sortSignals(signals: Signal[]): Signal[] {
  return signals.sort((a, b) =>
    a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : a.file < b.file ? -1 : 1,
  );
}

/** 读取 package.json 的依赖名字集合（依赖 + 开发依赖 + peer 依赖）。解析失败返回空集（空 catch 禁止 → 用返回值表达失败）。 */
export function readDependencyNames(
  projectRoot: string,
  manifestRelPath: string,
): ReadonlySet<string> {
  try {
    const content = fs.readFileSync(path.join(projectRoot, ...manifestRelPath.split('/')), 'utf-8');
    const parsed: unknown = JSON.parse(content);
    if (!isRecord(parsed)) return new Set();
    const names = new Set<string>();
    for (const section of ['dependencies', 'devDependencies', 'peerDependencies'] as const) {
      const deps = parsed[section];
      if (!isRecord(deps)) continue;
      for (const key of Object.keys(deps)) names.add(key);
    }
    return names;
  } catch {
    return new Set();
  }
}

/** 在依赖名集合中命中框架关键词 → 框架信号列表。 */
export function frameworkSignalsFromDeps(
  deps: ReadonlySet<string>,
  manifestRelPath: string,
  weight: number,
  frameworksByLanguage: ReadonlyArray<{
    readonly language: string;
    readonly frameworks: readonly { readonly name: string; readonly keywords: readonly string[] }[];
  }>,
): Signal[] {
  const signals: Signal[] = [];
  for (const entry of frameworksByLanguage) {
    for (const candidate of entry.frameworks) {
      const keyword = candidate.keywords.find((kw) => deps.has(kw));
      if (keyword === undefined) continue;
      signals.push(
        makeSignal({
          kind: 'manifest',
          ruleId: `manifest:framework:${slugify(candidate.name)}`,
          file: manifestRelPath,
          weight,
          payload: { framework: candidate.name, dependency: keyword, language: entry.language },
        }),
      );
    }
  }
  return signals;
}

/** 顶层目录形态约定信号（admin/web/app/miniapp/api/ios/android，depth=1，只出候选）。 */
export function conventionDirSignals(projectRoot: string, weight: number): Signal[] {
  const signals: Signal[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(projectRoot, { withFileTypes: true });
  } catch {
    return signals;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (!entry.isDirectory() || isNoiseDir(entry.name)) continue;
    const form: ProductFormId | undefined = FORM_DIR_RULES[entry.name];
    if (form === undefined) continue;
    signals.push(
      makeSignal({
        kind: 'form',
        ruleId: `form:dir-${entry.name}`,
        file: entry.name,
        weight,
        payload: {
          dirPath: entry.name,
          form,
        },
      }),
    );
  }
  return signals;
}

const MANIFEST_DEP_READERS: Readonly<Record<string, (content: string) => string[]>> = {
  'pyproject.toml': (c) => extractPyprojectDeps(c).map(normalizePackageName),
  'requirements.txt': (c) => extractRequirementsNames(c).map(normalizePackageName),
  'pom.xml': extractPomDependencies,
  'go.mod': extractGoModRequires,
  'Cargo.toml': extractCargoDeps,
  'composer.json': extractComposerRequire,
  Gemfile: extractGemfileDeps,
};

/** 按清单类型读取依赖名集合（与 manifest-detector 同源解析，供 form-detector 独立判断服务端框架原始信号）。 */
export function readManifestDepNames(
  projectRoot: string,
  rel: string,
  name: string,
): ReadonlySet<string> {
  if (name === 'package.json') return readDependencyNames(projectRoot, rel);
  const reader = MANIFEST_DEP_READERS[name];
  if (reader === undefined) return new Set();
  try {
    const content = fs.readFileSync(path.join(projectRoot, ...rel.split('/')), 'utf-8');
    return new Set(reader(content));
  } catch {
    return new Set();
  }
}
