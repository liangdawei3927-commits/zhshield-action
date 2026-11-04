// 各语言清单文件的依赖名提取（正则行解析，无外部依赖）。供 manifest-detector 读框架、lockfile-detector 读清单。
// pyproject.toml / requirements.txt 的行解析与包名规范化已收敛到 @zh/shared/manifest-parsers
// （与 @zh/pipeline 的 project-profile 共用同一份实现），此处原样重导出以保持既有导入路径。

import { isRecord } from '../fs-utils';
import { normalizePackageName, extractPyprojectDeps, extractRequirementsNames } from '@zh/shared';

export { normalizePackageName, extractPyprojectDeps, extractRequirementsNames };

const POM_ARTIFACT_RE = /<artifactId>([^<]+)<\/artifactId>/;
const WHITESPACE_RE = /\s+/;
const CARGO_SECTION_RE = /^\[(.*)\]$/;
const CARGO_DEP_SECTION_RE = /^dependencies$|^dev-dependencies$|^build-dependencies$/;
const CARGO_KEY_RE = /^([A-Za-z0-9_-]+)\s*=/;

/** pom.xml 的 <dependency><artifactId> 提取（含 groupId 消歧前缀）。 */
export function extractPomDependencies(content: string): string[] {
  const deps: string[] = [];
  for (const m of content.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
    const body = m[1];
    if (body === undefined) continue;
    const artifact = body.match(POM_ARTIFACT_RE);
    const artifactId = artifact?.[1];
    if (artifactId !== undefined) deps.push(artifactId.trim());
  }
  return deps;
}

/** go.mod 的 require 依赖（单行与括号块两种形态）。 */
export function extractGoModRequires(content: string): string[] {
  const deps: string[] = [];
  for (const m of content.matchAll(/^require\s+([^\s]+)\s+[^\s]+$/gm)) {
    const name = m[1];
    if (name !== undefined) deps.push(name);
  }
  for (const m of content.matchAll(/^require\s*\(([\s\S]*?)\)/g)) {
    const block = m[1];
    if (block === undefined) continue;
    for (const raw of block.split('\n')) {
      const parts = raw.trim().split(WHITESPACE_RE);
      const first = parts[0];
      if (first !== undefined && first.length > 0 && !first.startsWith('//')) deps.push(first);
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
    const sectionName = header?.[1];
    if (sectionName !== undefined) {
      inDeps = CARGO_DEP_SECTION_RE.test(sectionName.trim());
      continue;
    }
    if (!inDeps) continue;
    const key = line.match(CARGO_KEY_RE);
    const keyName = key?.[1];
    if (keyName !== undefined) deps.push(keyName);
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
  for (const m of content.matchAll(/^\s*gem\s+['"]([^'"]+)['"]/gm)) {
    const name = m[1];
    if (name !== undefined) deps.push(name);
  }
  return deps;
}
