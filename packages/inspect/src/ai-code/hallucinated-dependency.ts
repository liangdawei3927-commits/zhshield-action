/**
 * 幻觉依赖检测器（hallucinated-dependency.ts）
 *
 * 附 E.3：扫描 import/require 包名 → 本地离线查证（声明 / 锁文件 / node_modules）
 * → 未找到 = "幻觉依赖候选"；再与附 B typosquat 交叉验证（抢注即 typosquat-similar）。
 *
 * 边界 3（查证零外联）：registry 查证走附 A DataSourceRequirement 离线模式——
 * 本地无任何依赖信息（无 package.json / 锁文件 / node_modules）时输出
 * 'unverified-offline'，绝不输出"不存在"。
 */
import { TyposquatDetectorImpl } from '@zh/dependency';
import type { DependencyGraph, DependencyNode, ProjectProfile } from '@zh/dependency';

import { extractImportReferences, listNodeModules, readJsonSafe, readTextFileSafe } from './files';
import { collectLockfilePackages } from './lockfile';
import type { HallucinatedDependencyCheck, HallucinatedDependencyFinding } from './types';

const TEMPLATE_LITERAL_RE = /^\$\{.*\}$/;

function isWorkspacePackage(projectPath: string, packageName: string): boolean {
  if (!packageName.startsWith('@zh/')) return false;
  const pkg = readJsonSafe(`${projectPath}/package.json`);
  if (pkg === null) return false;
  const workspaces = pkg['workspaces'];
  if (!Array.isArray(workspaces)) return false;
  const scope = packageName.split('/')[1];
  if (scope === undefined) return false;
  return workspaces.some((w: string) => typeof w === 'string' && (w === `packages/${scope}` || w.includes(scope)));
}

/** 引用出处：文件 + 行号 */
interface RefSite {
  file: string;
  line: number;
}

/** 读取 package.json 中全部依赖声明（dependencies + dev + peer + optional） */
function collectDeclaredPackages(projectPath: string): ReadonlySet<string> {
  const declared = new Set<string>();
  const pkg = readJsonSafe(`${projectPath}/package.json`);
  if (pkg === null) return declared;
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const block = pkg[section];
    if (typeof block !== 'object' || block === null || Array.isArray(block)) continue;
    for (const name of Object.keys(block as Record<string, unknown>)) declared.add(name);
  }
  return declared;
}

/** 按包名分组 import 引用，并去重（同一 文件:行 只记一次） */
function groupRefsByPackage(refs: readonly { packageName: string; file: string; line: number }[]): Map<string, RefSite[]> {
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
      for (const line of [...lines].sort((a, b) => a - b)) sites.push({ file, line });
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

/**
 * 幻觉依赖检测实现：仅本地离线查证，零网络请求。
 * 返回按风险排序的候选：typosquat-similar（抢注最危）→ not-found → unverified-offline。
 */
export class HallucinatedDependencyCheckImpl implements HallucinatedDependencyCheck {
  private readonly typosquat: TyposquatDetectorImpl;

  constructor() {
    this.typosquat = new TyposquatDetectorImpl();
  }

  async check(project: ProjectProfile): Promise<readonly HallucinatedDependencyFinding[]> {
    const projectPath = project.projectPath;
    const declared = collectDeclaredPackages(projectPath);
    const locked = collectLockfilePackages(projectPath);
    const installed = listNodeModules(projectPath);

    // 本地依赖闭环信息是否可判定：三者任一存在即可判定"项目拥有依赖集合"
    const hasLocalManifest =
      readTextFileSafe(projectPath, 'package.json') !== null ||
      locked.size > 0 ||
      installed.size > 0;

    // 候选 = 源码引用了、但未被声明的包（声明过即信任，不再判幻觉）
    const refs = extractImportReferences(projectPath);
    const candidates = new Map<string, RefSite[]>();
    for (const [pkg, sites] of groupRefsByPackage(refs)) {
      if (declared.has(pkg)) continue;
      if (locked.has(pkg) || installed.has(pkg)) continue;
      if (isWorkspacePackage(projectPath, pkg)) continue;
      const firstSite = sites[0];
      if (firstSite !== undefined && TEMPLATE_LITERAL_RE.test(pkg)) continue;
      candidates.set(pkg, sites);
    }

    // 附 B 交叉验证：已引用幻觉名若被 typosquat 命中 → typosquat-similar
    const candidateNames = [...candidates.keys()];
    const typosquatFindings =
      candidateNames.length > 0 ? await this.typosquat.detect(buildTyposquatGraph(projectPath, candidateNames)) : [];
    const typosquatById = new Map(typosquatFindings.map((f: { nodeId: string; evidence: string[] }) => [f.nodeId, f]));

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
            ...(ts as { evidence: string[] }).evidence,
          ],
        });
        continue;
      }
      if (hasLocalManifest) {
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

    // 风险排序：typosquat-similar → not-found → unverified-offline，同级按包名
    const rank: Record<HallucinatedDependencyFinding['registryStatus'], number> = {
      'typosquat-similar': 0,
      'not-found': 1,
      'unverified-offline': 2,
    };
    findings.sort((a, b) => rank[a.registryStatus] - rank[b.registryStatus] || a.packageName.localeCompare(b.packageName));
    return findings;
  }
}
