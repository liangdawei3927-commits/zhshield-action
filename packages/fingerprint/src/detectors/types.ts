// Detector 共享助手：信号构造、目录形态信号、依赖名解析。

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Signal, SignalKind, ProductFormId } from '../types';
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

/** 构造信号（ruleId/kind/file/weight/payload；weight = 产出探测器的权重）。 */
export function makeSignal(
  kind: SignalKind,
  ruleId: string,
  file: string,
  weight: number,
  payload: unknown,
): Signal {
  return { ruleId, kind, file, weight, payload };
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
        makeSignal(
          'manifest',
          `manifest:framework:${slugify(candidate.name)}`,
          manifestRelPath,
          weight,
          { framework: candidate.name, dependency: keyword, language: entry.language },
        ),
      );
    }
  }
  return signals;
}

/** 顶层目录形态约定信号（admin/web/app/miniapp/api/ios/android，depth=1，只出候选）。 */
export function conventionDirSignals(projectRoot: string, weight: number): Signal[] {
  const signals: Signal[] = [];
  let entries: fs.Dirent[] = [];
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
      makeSignal('form', `form:dir-${entry.name}`, entry.name, weight, {
        dirPath: entry.name,
        form,
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
