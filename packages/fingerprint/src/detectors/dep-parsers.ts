// 各语言清单文件的依赖名提取（正则行解析，无外部依赖）。供 manifest-detector 读框架、lockfile-detector 读清单。

import { isRecord } from '../fs-utils';

const VERSION_SPLIT_RE = /[<>=!~[;]/;
const PYPROJECT_SECTION_RE = /^\[(.+)\]$/;
const PYPROJECT_KEY_RE = /^([A-Za-z0-9_.-]+)\s*=/;
const POM_ARTIFACT_RE = /<artifactId>([^<]+)<\/artifactId>/;
const WHITESPACE_RE = /\s+/;
const CARGO_SECTION_RE = /^\[(.*)\]$/;
const CARGO_DEP_SECTION_RE = /^dependencies$|^dev-dependencies$|^build-dependencies$/;
const CARGO_KEY_RE = /^([A-Za-z0-9_-]+)\s*=/;

/** 规范化包名：小写、`_` 与 `-` 等价，去掉版本/环境标记。 */
export function normalizePackageName(raw: string): string {
  return raw.split(VERSION_SPLIT_RE)[0].trim().toLowerCase().replace(/_/g, '-');
}

const PYPROJECT_DEP_SECTIONS: ReadonlySet<string> = new Set([
  'project',
  'project.dependencies',
  'tool.poetry.dependencies',
  'tool.uv.dependencies',
]);

export function extractPyprojectDeps(content: string): string[] {
  const deps: string[] = [];
  let inDeps = false;
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    const header = line.match(PYPROJECT_SECTION_RE);
    if (header) {
      inDeps = PYPROJECT_DEP_SECTIONS.has(header[1].trim());
      continue;
    }
    if (!inDeps) continue;
    const key = line.match(PYPROJECT_KEY_RE);
    if (key) deps.push(key[1]);
    for (const quoted of line.matchAll(/"([^"]+)"/g)) deps.push(quoted[1]);
  }
  return deps;
}

export function extractRequirementsNames(content: string): string[] {
  const names: string[] = [];
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('-')) continue;
    const name = line.split(VERSION_SPLIT_RE)[0].trim();
    if (name) names.push(name);
  }
  return names;
}

/** pom.xml 的 <dependency><artifactId> 提取（含 groupId 消歧前缀）。 */
export function extractPomDependencies(content: string): string[] {
  const deps: string[] = [];
  for (const m of content.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
    const artifact = m[1].match(POM_ARTIFACT_RE);
    if (artifact) deps.push(artifact[1].trim());
  }
  return deps;
}

/** go.mod 的 require 依赖（单行与括号块两种形态）。 */
export function extractGoModRequires(content: string): string[] {
  const deps: string[] = [];
  for (const m of content.matchAll(/^require\s+([^\s]+)\s+[^\s]+$/gm)) deps.push(m[1]);
  for (const m of content.matchAll(/^require\s*\(([\s\S]*?)\)/g)) {
    for (const raw of m[1].split('\n')) {
      const parts = raw.trim().split(WHITESPACE_RE);
      if (parts.length > 0 && parts[0] && !parts[0].startsWith('//')) deps.push(parts[0]);
    }
  }
  return deps;
}

/** Cargo.toml 的 [dependencies]/[dev-dependencies]/[build-dependencies] 键名。 */
export function extractCargoDeps(content: string): string[] {
  const deps: string[] = [];
  let inDeps = false;
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    const header = line.match(CARGO_SECTION_RE);
    if (header) {
      inDeps = CARGO_DEP_SECTION_RE.test(header[1].trim());
      continue;
    }
    if (!inDeps) continue;
    const key = line.match(CARGO_KEY_RE);
    if (key) deps.push(key[1]);
  }
  return deps;
}

/** composer.json 的 require/require-dev 键名。 */
export function extractComposerRequire(content: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }
  if (!isRecord(parsed)) return [];
  const names: string[] = [];
  for (const section of ['require', 'require-dev'] as const) {
    const req = parsed[section];
    if (!isRecord(req)) continue;
    for (const key of Object.keys(req)) names.push(key);
  }
  return names;
}

/** Gemfile 的 gem 声明。 */
export function extractGemfileDeps(content: string): string[] {
  const deps: string[] = [];
  for (const m of content.matchAll(/^\s*gem\s+['"]([^'"]+)['"]/gm)) deps.push(m[1]);
  return deps;
}
