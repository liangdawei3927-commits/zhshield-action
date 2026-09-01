/**
 * 幻觉依赖检测器（hallucinated-dependency.ts）
 *
 * 附 E.3：扫描 import/require 包名 → 本地离线查证（声明 / 锁文件 / node_modules）
 * → 未找到 = "幻觉依赖候选"；再与附 B typosquat 交叉验证（抢注即 typosquat-similar）。
 *
 * 依赖闭包解析（monorepo 感知）：
 * - 对每个 import 引用点，从其所在文件目录向上查找最近的 package.json，
 *   以该目录作为此引用的声明闭包根（包内自声明优先）。
 * - 再自清单根向上查找 pnpm-workspace.yaml（或带 workspaces 字段的 package.json），
 *   找到则视为工作区根，用其锁文件 / node_modules 补充闭包；@scope/name 若对应
 *   工作区里实际存在的包（package.json name 匹配）则视为本地工作区包，直接豁免。
 * - 因此扫描入口无论是仓库根、某个子包目录，还是无清单的父容器目录，都能解析到
 *   真实依赖声明：已声明 / 已安装 / 工作区包不会被误报为幻觉。
 * - 边界 3（查证零外联）：某引用点向上全无清单（入口亦无锁文件 / node_modules）时
 *   输出 'unverified-offline'，绝不输出"不存在"。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

// 依赖注入边界：字段/契约依赖接口 TyposquatDetector，仅构造点引用实现类 TyposquatDetectorImpl
import type {
  TyposquatDetector,
  DependencyGraph,
  DependencyNode,
  ProjectProfile,
} from '@zh/dependency';
import { TyposquatDetectorImpl } from '@zh/dependency';

import { extractImportReferences, listNodeModules, readJsonSafe, readTextFileSafe } from './files';
import { collectLockfilePackages } from './lockfile';
import type { HallucinatedDependencyCheck, HallucinatedDependencyFinding } from './types';

const TEMPLATE_LITERAL_RE = /^\$\{.*\}$/;

/** 自 startDir 向上查找第一个包含 marker 文件的目录（含自身）；找不到返回 null */
function findUp(startDir: string, marker: string): string | null {
  let dir = path.resolve(startDir);
  for (;;) {
    if (fs.existsSync(path.join(dir, marker))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** 单条 import 引用点的依赖上下文：最近清单目录 + 工作区根 */
interface DependencyContext {
  /** 引用点向上最近的 package.json 所在目录（null = 该点无任何清单上下文） */
  manifestDir: string | null;
  /** 工作区根（含 pnpm-workspace.yaml 或 workspaces 字段）；无则 null */
  workspaceRoot: string | null;
}

function resolveContext(projectPath: string, relFile: string): DependencyContext {
  const manifestDir = findUp(path.dirname(path.resolve(projectPath, relFile)), 'package.json');
  if (manifestDir === null) return { manifestDir: null, workspaceRoot: null };
  let dir = manifestDir;
  for (;;) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml')))
      return { manifestDir, workspaceRoot: dir };
    const pkg = readJsonSafe(`${dir}/package.json`);
    if (pkg !== null && Array.isArray(pkg['workspaces']))
      return { manifestDir, workspaceRoot: dir };
    const parent = path.dirname(dir);
    if (parent === dir) return { manifestDir, workspaceRoot: null };
    dir = parent;
  }
}

/** 解析 pnpm-workspace.yaml 的 packages 通配段（如 ['packages/*']），防目录穿越 */
const YAML_LINE_BREAKS_RE = /\r?\n/;
const QUOTES_RE = /^['"]|['"]$/g;
const TRAILING_GLOB_RE = /\*\*?$/;

function parsePnpmWorkspaceGlobs(yaml: string): string[] {
  const lines = yaml.split(YAML_LINE_BREAKS_RE);
  const start = lines.findIndex((l) => l.trim().startsWith('packages:'));
  if (start < 0) return [];
  const globs: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (!trimmed.startsWith('-')) break;
    const glob = trimmed.slice(1).trim().replace(QUOTES_RE, '');
    if (glob.length > 0 && !glob.includes('..')) globs.push(glob);
  }
  return globs;
}

/** 在 root 下按 patterns（'packages/*' 等）探测 packageName 对应目录，命中且 name 匹配才认可 */
function packageExistsAt(root: string, packageName: string, patterns: readonly string[]): boolean {
  const [scope, name] = packageName.split('/');
  if (scope === undefined || name === undefined) return false;
  for (const pattern of patterns) {
    const prefix = pattern.replace(TRAILING_GLOB_RE, '');
    const pkgJson = readJsonSafe(path.join(root, prefix, name, 'package.json'));
    if (pkgJson !== null && pkgJson['name'] === packageName) return true;
  }
  return false;
}

/**
 * 工作区包判定：pnpm-workspace.yaml globs 或 npm/yarn workspaces 字段命中，
 * 且对应目录内 package.json name 与引用名一致。
 */
function isWorkspacePackage(ctx: DependencyContext, packageName: string): boolean {
  if (!packageName.startsWith('@')) return false;
  const roots = new Set<string>();
  if (ctx.workspaceRoot !== null) roots.add(ctx.workspaceRoot);
  if (ctx.manifestDir !== null) roots.add(ctx.manifestDir);
  for (const root of roots) {
    const wsYaml = readTextFileSafe(root, 'pnpm-workspace.yaml');
    if (wsYaml !== null && packageExistsAt(root, packageName, parsePnpmWorkspaceGlobs(wsYaml)))
      return true;
    const pkg = readJsonSafe(`${root}/package.json`);
    if (pkg !== null && Array.isArray(pkg['workspaces'])) {
      if (
        packageExistsAt(
          root,
          packageName,
          (pkg['workspaces'] as unknown[]).map((w) => String(w)),
        )
      )
        return true;
    }
  }
  return false;
}

/** 引用出处：文件 + 行号 */
interface RefSite {
  file: string;
  line: number;
}

/** 读取 package.json 中全部依赖声明（dependencies + dev + peer + optional） */
function collectDeclaredPackages(dir: string): ReadonlySet<string> {
  const declared = new Set<string>();
  const pkg = readJsonSafe(`${dir}/package.json`);
  if (pkg === null) return declared;
  for (const section of [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ]) {
    const block = pkg[section];
    if (typeof block !== 'object' || block === null || Array.isArray(block)) continue;
    for (const name of Object.keys(block as Record<string, unknown>)) declared.add(name);
  }
  return declared;
}

/** 按包名分组 import 引用，并去重（同一 文件:行 只记一次） */
function groupRefsByPackage(
  refs: readonly { packageName: string; file: string; line: number }[],
): Map<string, RefSite[]> {
  const byPkg = new Map<string, Map<string, Set<number>>>();
  for (const ref of refs) {
    let byFile = byPkg.get(ref.packageName);
    if (byFile === undefined) {
      byFile = new Map();
      byPkg.set(ref.packageName, byFile);
    }
    let lines = byFile.get(ref.file);
    if (lines === undefined) {
      lines = new Set();
      byFile.set(ref.file, lines);
    }
    lines.add(ref.line);
  }
  const out = new Map<string, RefSite[]>();
  for (const [pkg, byFile] of byPkg) {
    const sites: RefSite[] = [];
    for (const [file, lines] of byFile) {
      for (const line of Array.from(lines, (n) => n).toSorted((a, b) => a - b))
        sites.push({ file, line });
    }
    sites.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)));
    out.set(pkg, sites);
  }
  return out;
}

/** 为幻觉候选构造附 B 交叉验证用的依赖图谱节点（仅消费包名） */
function buildTyposquatGraph(projectPath: string, candidates: readonly string[]): DependencyGraph {
  const nodes: DependencyNode[] = candidates.map((name) => ({
    id: `${name}@0.0.0`, // 版本未知：typosquat 判定仅依赖名称，占位即可
    name,
    version: '0.0.0',
    declaredRange: '',
    kind: 'transitive',
    trust: 'unknown',
    vulnerabilities: [],
  }));
  return {
    schemaVersion: 1,
    targetId: projectPath,
    ecosystem: 'npm', // 本检测器只扫描 npm 生态 import/require
    nodes,
    edges: [],
    lockfile: { present: false, consistent: false, integrityVerified: false },
    generatedAt: new Date().toISOString(),
  };
}

/** 读取并缓存某目录的声明集（带缓存） */
function declaredAt(dir: string, cache: Map<string, ReadonlySet<string>>): ReadonlySet<string> {
  let set = cache.get(dir);
  if (set === undefined) {
    set = collectDeclaredPackages(dir);
    cache.set(dir, set);
  }
  return set;
}

/** 读取并缓存某闭包根的锁文件/安装集（带缓存） */
function closureAt(
  root: string,
  cache: Map<string, { locked: ReadonlySet<string>; installed: ReadonlySet<string> }>,
): { locked: ReadonlySet<string>; installed: ReadonlySet<string> } {
  let c = cache.get(root);
  if (c === undefined) {
    c = { locked: collectLockfilePackages(root), installed: listNodeModules(root) };
    cache.set(root, c);
  }
  return c;
}

/**
 * 幻觉依赖检测实现：仅本地离线查证，零网络请求。
 * 返回按风险排序的候选：typosquat-similar（抢注最危）→ not-found → unverified-offline。
 */
export class HallucinatedDependencyCheckImpl implements HallucinatedDependencyCheck {
  private readonly typosquat: TyposquatDetector;

  constructor() {
    this.typosquat = new TyposquatDetectorImpl();
  }

  async check(project: ProjectProfile): Promise<readonly HallucinatedDependencyFinding[]> {
    const projectPath = project.projectPath;
    const { projectLocked, projectInstalled, declaredCache, closureCache, contextCache } =
      this.setupCaches(projectPath);
    const { candidates, manifestSeen } = this.collectCandidates(
      projectPath,
      projectLocked,
      projectInstalled,
      declaredCache,
      closureCache,
      contextCache,
    );
    const typosquatById = await this.runTyposquatCheck(projectPath, candidates);
    const findings = this.buildFindings(candidates, manifestSeen, typosquatById);
    this.sortFindings(findings);
    return findings;
  }

  /** 初始化入口级闭包与各级缓存 */
  private setupCaches(projectPath: string): {
    projectLocked: ReadonlySet<string>;
    projectInstalled: ReadonlySet<string>;
    declaredCache: Map<string, ReadonlySet<string>>;
    closureCache: Map<string, { locked: ReadonlySet<string>; installed: ReadonlySet<string> }>;
    contextCache: Map<string, DependencyContext>;
  } {
    // 入口级闭包（旧行为保留）：引用点无清单上下文时的回退判据
    const projectLocked = collectLockfilePackages(projectPath);
    const projectInstalled = listNodeModules(projectPath);
    // 缓存：manifestDir → 声明集；闭包根 → 锁文件/安装集；引用文件 → 上下文
    const declaredCache = new Map<string, ReadonlySet<string>>();
    const closureCache = new Map<
      string,
      { locked: ReadonlySet<string>; installed: ReadonlySet<string> }
    >();
    const contextCache = new Map<string, DependencyContext>();
    return { projectLocked, projectInstalled, declaredCache, closureCache, contextCache };
  }

  /** 解析单个包的全部引用点：返回未解析引用、是否已解析、是否出现过清单上下文 */
  private resolvePackageSites(
    projectPath: string,
    pkg: string,
    sites: readonly RefSite[],
    projectLocked: ReadonlySet<string>,
    projectInstalled: ReadonlySet<string>,
    declaredCache: Map<string, ReadonlySet<string>>,
    closureCache: Map<string, { locked: ReadonlySet<string>; installed: ReadonlySet<string> }>,
    contextCache: Map<string, DependencyContext>,
  ): { unresolved: RefSite[]; anyResolved: boolean; anyManifestContext: boolean } {
    const unresolved: RefSite[] = [];
    let anyResolved = false;
    let anyManifestContext = false;
    for (const site of sites) {
      let ctx = contextCache.get(site.file);
      if (ctx === undefined) {
        ctx = resolveContext(projectPath, site.file);
        contextCache.set(site.file, ctx);
      }
      if (ctx.manifestDir === null) {
        // 无清单上下文：仅入口级闭包可佐证
        if (
          declaredAt(projectPath, declaredCache).has(pkg) ||
          projectLocked.has(pkg) ||
          projectInstalled.has(pkg)
        ) {
          anyResolved = true;
          break;
        }
        unresolved.push(site);
        continue;
      }
      anyManifestContext = true;
      if (declaredAt(ctx.manifestDir, declaredCache).has(pkg)) {
        anyResolved = true;
        break;
      }
      const closureRoot = ctx.workspaceRoot ?? ctx.manifestDir;
      const closure = closureAt(closureRoot, closureCache);
      if (closure.locked.has(pkg) || closure.installed.has(pkg)) {
        anyResolved = true;
        break;
      }
      if (isWorkspacePackage(ctx, pkg)) {
        anyResolved = true;
        break;
      }
      unresolved.push(site);
    }
    return { unresolved, anyResolved, anyManifestContext };
  }

  /** 遍历 import 引用，解析每个引用点并收集未解析的幻觉候选 */
  private collectCandidates(
    projectPath: string,
    projectLocked: ReadonlySet<string>,
    projectInstalled: ReadonlySet<string>,
    declaredCache: Map<string, ReadonlySet<string>>,
    closureCache: Map<string, { locked: ReadonlySet<string>; installed: ReadonlySet<string> }>,
    contextCache: Map<string, DependencyContext>,
  ): { candidates: Map<string, RefSite[]>; manifestSeen: Map<string, boolean> } {
    const refs = extractImportReferences(projectPath);
    const candidates = new Map<string, RefSite[]>();
    const manifestSeen = new Map<string, boolean>();

    for (const [pkg, sites] of groupRefsByPackage(refs)) {
      if (TEMPLATE_LITERAL_RE.test(pkg)) continue;
      const { unresolved, anyResolved, anyManifestContext } = this.resolvePackageSites(
        projectPath,
        pkg,
        sites,
        projectLocked,
        projectInstalled,
        declaredCache,
        closureCache,
        contextCache,
      );
      if (anyResolved) continue;
      if (unresolved.length === 0) continue;
      manifestSeen.set(pkg, anyManifestContext);
      candidates.set(pkg, unresolved);
    }
    return { candidates, manifestSeen };
  }

  /** 附 B 交叉验证：已引用幻觉名若被 typosquat 命中 → typosquat-similar */
  private async runTyposquatCheck(
    projectPath: string,
    candidates: Map<string, RefSite[]>,
  ): Promise<Map<string, { evidence: string[] }>> {
    const candidateNames = [...candidates.keys()];
    const typosquatFindings =
      candidateNames.length > 0
        ? await this.typosquat.detect(buildTyposquatGraph(projectPath, candidateNames))
        : [];
    return new Map(
      typosquatFindings.map((f: { nodeId: string; evidence: string[] }) => [f.nodeId, f]),
    );
  }

  /** 依据 typosquat 命中与清单上下文构建分级结果 */
  private buildFindings(
    candidates: Map<string, RefSite[]>,
    manifestSeen: Map<string, boolean>,
    typosquatById: Map<string, { evidence: string[] }>,
  ): HallucinatedDependencyFinding[] {
    const findings: HallucinatedDependencyFinding[] = [];
    for (const [pkg, sites] of candidates) {
      const ts = typosquatById.get(`${pkg}@0.0.0`);
      const siteText = sites.map((s) => `'${s.file}:${s.line}'`).join(', ');
      if (ts !== undefined) {
        findings.push({
          packageName: pkg,
          referencedFrom: sites,
          registryStatus: 'typosquat-similar',
          evidence: [
            `imported from ${siteText}`,
            `locally absent from package.json, lockfile and node_modules`,
            ...ts.evidence,
          ],
        });
        continue;
      }
      if (manifestSeen.get(pkg) === true) {
        findings.push({
          packageName: pkg,
          referencedFrom: sites,
          registryStatus: 'not-found',
          evidence: [
            `imported from ${siteText}`,
            `absent from local dependency closure (package.json / lockfile / node_modules)`,
          ],
        });
      } else {
        findings.push({
          packageName: pkg,
          referencedFrom: sites,
          registryStatus: 'unverified-offline',
          evidence: [
            `imported from ${siteText}`,
            `no local dependency manifest found; offline verification unavailable (not confirmed missing)`,
          ],
        });
      }
    }
    return findings;
  }

  /** 风险排序：typosquat-similar → not-found → unverified-offline，同级按包名 */
  private sortFindings(findings: HallucinatedDependencyFinding[]): void {
    const rank: Record<HallucinatedDependencyFinding['registryStatus'], number> = {
      'typosquat-similar': 0,
      'not-found': 1,
      'unverified-offline': 2,
    };
    findings.sort(
      (a, b) =>
        rank[a.registryStatus] - rank[b.registryStatus] ||
        a.packageName.localeCompare(b.packageName),
    );
  }
}
