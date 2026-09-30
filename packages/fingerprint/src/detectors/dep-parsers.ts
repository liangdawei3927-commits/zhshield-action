// 各语言清单文件的依赖名提取（正则行解析，无外部依赖）。供 manifest-detector 读框架、lockfile-detector 读清单。
// pyproject.toml / requirements.txt 的行解析与包名规范化已收敛到 @zh/shared/manifest-parsers
// （与 @zh/pipeline 的 project-profile 共用同一份实现），此处原样重导出以保持既有导入路径。

import { isRecord } from '../fs-utils';
import {
  normalizePackageName,
  extractPyprojectDeps,
  extractRequirementsNames,
} from '@zh/shared';

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
