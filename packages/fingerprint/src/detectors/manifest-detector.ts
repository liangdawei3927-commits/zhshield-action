// manifest-detector（权重 1.0）：清单文件 → 语言 + 框架（依赖读）+ 包管理器（lockfile 名判断）。

import * as fs from 'node:fs';
import * as path from 'node:path';
import { safeJoinReal } from '@zh/shared';
import type { Detector } from '../detector';
import type { Signal, SignalKind, LanguageId } from '../types';
import { MANIFEST_RULES, LOCKFILE_MANAGERS } from '../language-map';
import { FRAMEWORK_KEYWORDS } from '../framework-map';
import { listRootFiles, readText, relDirname, isRecord, isNoiseDir } from '../fs-utils';
import { SKIP_DIRS } from '../detector';
import { makeSignal, readDependencyNames, frameworkSignalsFromDeps } from './types';
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

const PNPM_WORKSPACE_RE = /^\s+-\s+['"]?([^'"]+)['"]?\s*$/;

/** 解析 pnpm-workspace.yaml 获取 workspace glob patterns */
function readPnpmWorkspacePatterns(projectRoot: string): string[] {
  let content: string;
  try {
    content = readText(projectRoot, 'pnpm-workspace.yaml');
  } catch {
    return [];
  }
  const patterns: string[] = [];
  let inPackages = false;
  for (const line of content.split('\n')) {
    if (line.trim() === 'packages:') {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      const match = line.match(PNPM_WORKSPACE_RE);
      if (match !== null) {
        patterns.push(match[1]);
      } else if (line.trim().length > 0 && !line.startsWith(' ')) {
        break;
      }
    }
  }
  return patterns;
}

export function expandWorkspaceGlobs(projectRoot: string, patterns: string[]): string[] {
  const dirs: string[] = [];
  const isNoiseRel = (rel: string): boolean => rel.split('/').some((segment) => isNoiseDir(segment));
  for (const pattern of patterns) {
    if (!pattern.includes('*')) {
      let absDir: string;
      try {
        absDir = safeJoinReal(projectRoot, pattern);
      } catch {
        continue; // 越界 pattern（含 .. 或绝对路径），跳过
      }
      if (fs.existsSync(absDir) && fs.statSync(absDir).isDirectory() && !isNoiseRel(pattern)) {
        dirs.push(pattern);
      }
      continue;
    }
    const parts = pattern.split('/');
    const globIdx = parts.findIndex((p) => p === '*');
    if (globIdx === -1) continue;
    let baseDir: string;
    try {
      baseDir = safeJoinReal(projectRoot, ...parts.slice(0, globIdx));
    } catch {
      continue;
    }
    if (!fs.existsSync(baseDir) || !fs.statSync(baseDir).isDirectory()) continue;
    try {
      for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const rest = parts.slice(globIdx + 1).join('/');
        const candidate = rest.length > 0 ? path.join(baseDir, entry.name, rest) : path.join(baseDir, entry.name);
        if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
          const rel = path.relative(projectRoot, candidate);
          if (isNoiseRel(rel)) continue;
          dirs.push(rel);
        }
      }
    } catch {
      // skip unreadable dirs
    }
  }
  return dirs;
}

/** 解析根 package.json 的 workspaces 字段（npm/yarn 风格）获取 workspace glob patterns。 */
function readPackageJsonWorkspacePatterns(projectRoot: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readText(projectRoot, 'package.json'));
  } catch {
    return [];
  }
  if (!isRecord(parsed)) return [];
  const workspaces = parsed.workspaces;
  const raw: unknown = isRecord(workspaces) ? workspaces.packages : workspaces;
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === 'string');
}

const KIND: SignalKind = 'manifest';

const JS_FRAMEWORKS = [{ language: 'javascript', frameworks: FRAMEWORK_KEYWORDS.javascript }];
const PYTHON_FRAMEWORKS = [{ language: 'python', frameworks: FRAMEWORK_KEYWORDS.python }];
const JAVA_FRAMEWORKS = [{ language: 'java', frameworks: FRAMEWORK_KEYWORDS.java }];
const GO_FRAMEWORKS = [{ language: 'go', frameworks: FRAMEWORK_KEYWORDS.go }];
const RUST_FRAMEWORKS = [{ language: 'rust', frameworks: FRAMEWORK_KEYWORDS.rust }];
const PHP_FRAMEWORKS = [{ language: 'php', frameworks: FRAMEWORK_KEYWORDS.php }];
const RUBY_FRAMEWORKS = [{ language: 'ruby', frameworks: FRAMEWORK_KEYWORDS.ruby }];

const JS_MANIFEST_NAMES = new Set(['package.json', 'pyproject.toml', 'requirements.txt', 'Pipfile']);

/** 在 manifest 所在目录找 lockfile → 包管理器信号（package.json / Python 清单附带）。 */
function packageManagerSignals(projectRoot: string, manifestRelPath: string, manifestName: string, weight: number): Signal[] {
  if (!JS_MANIFEST_NAMES.has(manifestName)) return [];
  const dir = relDirname(manifestRelPath);
  const signals: Signal[] = [];
  for (const [lockName, manager] of Object.entries(LOCKFILE_MANAGERS)) {
    const rel = dir === '.' ? lockName : `${dir}/${lockName}`;
    if (fs.existsSync(path.join(projectRoot, ...rel.split('/')))) {
      signals.push(makeSignal(KIND, `manifest:package-manager:${manager}`, rel, weight, { manager, packageManager: manager }));
    }
  }
  return signals;
}

function findProjectRoot(projectPath: string): string {
  const manifestNames = ['package.json', 'pyproject.toml', 'requirements.txt', 'Cargo.toml', 'go.mod', 'pom.xml', 'Gemfile'];
  for (const name of listRootFiles(projectPath)) {
    if (manifestNames.includes(name)) return projectPath;
  }
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(projectPath, { withFileTypes: true });
  } catch {
    return projectPath;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || SKIP_DIRS.has(entry.name)) continue;
    const sub = path.join(projectPath, entry.name);
    for (const name of listRootFiles(sub)) {
      if (manifestNames.includes(name)) return sub;
    }
  }
  return projectPath;
}

export class ManifestDetector implements Detector {
  readonly id = 'manifest-detector';
  readonly signalKinds = [KIND] as const;
  readonly weight = 1.0;

  async detect(projectPath: string): Promise<Signal[]> {
    const root = findProjectRoot(projectPath);
    const signals: Signal[] = [];
    for (const name of listRootFiles(root)) {
      const rule = MANIFEST_RULES.find((r) => r.match(name));
      if (rule === undefined) continue;
      const rel = root === projectPath ? name : path.relative(projectPath, root) + '/' + name;
      signals.push(...this.detectManifest(projectPath, rel, name, rule.ruleId, rule.language));
    }

    const workspacePatterns = [
      ...new Set([...readPnpmWorkspacePatterns(root), ...readPackageJsonWorkspacePatterns(root)]),
    ];
    if (workspacePatterns.length > 0) {
      const workspaceDirs = expandWorkspaceGlobs(root, workspacePatterns);
      for (const dir of new Set(workspaceDirs)) {
        for (const name of listRootFiles(path.join(root, dir))) {
          if (name !== 'package.json') continue;
          const rel = (root === projectPath ? '' : path.relative(projectPath, root) + '/') + dir + '/' + name;
          signals.push(...this.detectManifest(projectPath, rel, name, 'manifest:package-json', 'typescript'));
        }
      }
    }

    return signals.sort((a, b) => (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : a.file < b.file ? -1 : 1));
  }

  private detectManifest(projectRoot: string, rel: string, name: string, ruleId: string, _language: LanguageId): Signal[] {
    switch (ruleId) {
      case 'manifest:package-json':
        return this.detectPackageJson(projectRoot, rel);
      case 'manifest:pyproject':
        return this.detectPythonText(projectRoot, rel, ruleId, 'pyproject');
      case 'manifest:requirements-txt':
        return this.detectPythonText(projectRoot, rel, ruleId, 'requirements');
      case 'manifest:setup-py':
      case 'manifest:pipfile':
        return [makeSignal(KIND, ruleId, rel, this.weight, { deps: [] }), ...packageManagerSignals(projectRoot, rel, name, this.weight)];
      case 'manifest:pom-xml':
        return this.detectPom(projectRoot, rel);
      case 'manifest:go-mod':
        return this.detectGoMod(projectRoot, rel);
      case 'manifest:cargo-toml':
        return this.detectCargo(projectRoot, rel);
      case 'manifest:composer-json':
        return this.detectComposer(projectRoot, rel);
      case 'manifest:gemfile':
        return this.detectGemfile(projectRoot, rel);
      default:
        return [makeSignal(KIND, ruleId, rel, this.weight, { deps: [] })];
    }
  }

  private detectPackageJson(projectRoot: string, rel: string): Signal[] {
    const signals: Signal[] = [];
    const names = readDependencyNames(projectRoot, rel);
    signals.push(makeSignal(KIND, 'manifest:package-json', rel, this.weight, { dependencies: [...names] }));
    if (names.has('typescript') || names.has('ts-node')) {
      signals.push(makeSignal(KIND, 'manifest:typescript-dep', rel, this.weight, { dependency: 'typescript' }));
    }
    if (readHasWorkspaces(projectRoot, rel)) {
      signals.push(makeSignal(KIND, 'manifest:workspace', rel, this.weight, {}));
    }
    signals.push(...frameworkSignalsFromDeps(names, rel, this.weight, JS_FRAMEWORKS));
    signals.push(...packageManagerSignals(projectRoot, rel, 'package.json', this.weight));
    const engines = readEngines(projectRoot, rel);
    if (engines !== null) signals.push(makeSignal(KIND, 'manifest:node-engine', rel, this.weight, { version: engines }));
    return signals;
  }

  private detectPythonText(projectRoot: string, rel: string, ruleId: string, kind: 'pyproject' | 'requirements'): Signal[] {
    const content = readText(projectRoot, rel);
    const rawDeps =
      kind === 'pyproject' ? extractPyprojectDeps(content) : extractRequirementsNames(content);
    const deps = [...new Set(rawDeps.map(normalizePackageName))].filter((d) => d.length > 0);
    const signals: Signal[] = [makeSignal(KIND, ruleId, rel, this.weight, { deps })];
    signals.push(...frameworkSignalsFromDeps(new Set(deps), rel, this.weight, PYTHON_FRAMEWORKS));
    signals.push(...packageManagerSignals(projectRoot, rel, rel.slice(rel.lastIndexOf('/') + 1), this.weight));
    return signals;
  }

  private detectPom(projectRoot: string, rel: string): Signal[] {
    const deps = [...new Set(extractPomDependencies(readText(projectRoot, rel)))];
    const signals: Signal[] = [makeSignal(KIND, 'manifest:pom-xml', rel, this.weight, { deps })];
    signals.push(...frameworkSignalsFromDeps(new Set(deps), rel, this.weight, JAVA_FRAMEWORKS));
    return signals;
  }

  private detectGoMod(projectRoot: string, rel: string): Signal[] {
    const deps = [...new Set(extractGoModRequires(readText(projectRoot, rel)))];
    const signals: Signal[] = [makeSignal(KIND, 'manifest:go-mod', rel, this.weight, { deps })];
    signals.push(...frameworkSignalsFromDeps(new Set(deps), rel, this.weight, GO_FRAMEWORKS));
    return signals;
  }

  private detectCargo(projectRoot: string, rel: string): Signal[] {
    const deps = [...new Set(extractCargoDeps(readText(projectRoot, rel)))];
    const signals: Signal[] = [makeSignal(KIND, 'manifest:cargo-toml', rel, this.weight, { deps })];
    signals.push(...frameworkSignalsFromDeps(new Set(deps), rel, this.weight, RUST_FRAMEWORKS));
    return signals;
  }

  private detectComposer(projectRoot: string, rel: string): Signal[] {
    const deps = [...new Set(extractComposerRequire(readText(projectRoot, rel)))];
    const signals: Signal[] = [makeSignal(KIND, 'manifest:composer-json', rel, this.weight, { deps })];
    signals.push(...frameworkSignalsFromDeps(new Set(deps), rel, this.weight, PHP_FRAMEWORKS));
    return signals;
  }

  private detectGemfile(projectRoot: string, rel: string): Signal[] {
    const deps = [...new Set(extractGemfileDeps(readText(projectRoot, rel)))];
    const signals: Signal[] = [makeSignal(KIND, 'manifest:gemfile', rel, this.weight, { deps })];
    signals.push(...frameworkSignalsFromDeps(new Set(deps), rel, this.weight, RUBY_FRAMEWORKS));
    return signals;
  }
}

/** 读取 package.json engines.node 版本。 */
function readEngines(projectRoot: string, rel: string): string | null {
  try {
    const parsed: unknown = JSON.parse(readText(projectRoot, rel));
    if (!isRecord(parsed)) return null;
    const engines = parsed.engines;
    if (!isRecord(engines)) return null;
    const node = engines.node;
    return typeof node === 'string' && node.length > 0 ? node : null;
  } catch {
    return null;
  }
}

/** package.json 是否存在 workspaces 字段（monorepo 聚合判定信号）。 */
function readHasWorkspaces(projectRoot: string, rel: string): boolean {
  try {
    const parsed: unknown = JSON.parse(readText(projectRoot, rel));
    if (!isRecord(parsed)) return false;
    return Array.isArray(parsed.workspaces) || isRecord(parsed.workspaces);
  } catch {
    return false;
  }
}
