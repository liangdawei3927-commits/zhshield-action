/**
 * Python 清单解析（graph-builder-python.ts）
 *
 * 解析 requirements.txt / pyproject.toml（PEP 621 + poetry）/ Pipfile.lock / poetry.lock，
 * 输出节点与根边；由 graph-builder.ts 统一调度。
 */
import {
  collectPipfileLockDeps,
  collectPyprojectDependencies,
  isRecord,
  readPoetryLockPackages,
  readTextSafe,
  versionFromConstraint,
} from './lockfile-utils';
import type { DependencyEdge, DependencyNode } from './types';
import { ROOT_NODE_ID } from './types';
import { safeJoin } from '@zh/shared';
import type { BuildResult } from './graph-builder-shared';
import { buildRootEdges, makeNode } from './graph-builder-shared';

// ────────────────────────────── 模块级正则常量（避免每次调用重编译） ──────────────────────────────
/** 换行符拆分 */
const NEWLINE_RE = /\r?\n/;
/** PEP 508 包名 */
const PEP508_NAME_RE = /^[A-Za-z0-9_.-]+/;
/** 版本约束操作符匹配 */
const CONSTRAINT_RE = /(?:==|>=|<=|!=|~=|===|>|<)\s*[^\s]+/;
/** 行注释剥离（#...） */
const COMMENT_STRIPPING_RE = /#.*/;

// ────────────────────────────── Python ──────────────────────────────

/** requirements.txt：逐行剥离 # 注释、环境标记、extras，跳过空行与 - 开头的选项行 */
function parseRequirements(content: string): Array<{ name: string; constraint: string }> {
  const deps: Array<{ name: string; constraint: string }> = [];
  for (const rawLine of content.split(NEWLINE_RE)) {
    let line = rawLine.replace(COMMENT_STRIPPING_RE, '').trim();
    if (line === '' || line.startsWith('-')) continue;
    line = line.split(';')[0].trim();
    line = line.replace(/\[.*?\]/g, '');
    const m = line.match(PEP508_NAME_RE);
    if (!m) continue;
    const name = m[0];
    const rest = line.slice(name.length).trim();
    const constraint = rest.match(CONSTRAINT_RE)?.[0] ?? '';
    deps.push({ name, constraint });
  }
  return deps;
}

/**
 * pyproject.toml：按节拆分，仅处理目标区块——
 * [project] 的 dependencies 数组（PEP 621，双引号包名，附带版本约束）；
 * [tool.poetry.dependencies] / [tool.uv.dependencies] 的表键即包名。
 */
function parsePyproject(content: string): {
  dependencies: Map<string, string>;
  devDependencies: Map<string, string>;
} {
  const dependencies = new Map<string, string>();
  const devDependencies = new Map<string, string>();
  collectPyprojectDependencies(content, dependencies);

  return { dependencies, devDependencies };
}

/** Pipfile.lock JSON：default / develop 两个区块的键即包名，version 字段为声明范围 */
function parsePipfileLock(content: string): Array<{ name: string; declaredRange: string }> {
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    // 无法解析时按缺失处理
    return [];
  }
  if (!isRecord(data)) return [];

  return collectPipfileLockDeps(data);
}

/** poetry.lock：[[package]] 块的 name / version 字段 */
function parsePoetryLock(content: string): Array<{ name: string; version: string }> {
  return readPoetryLockPackages(content).map((pkg) => ({
    name: pkg.name,
    version: pkg.version,
  }));
}

/** poetry.lock 图谱：pyproject.toml 提供声明与范围，poetry.lock 提供锁定版本 */
export function buildPoetryGraph(poetryLockPath: string, projectPath: string): BuildResult {
  const content = readTextSafe(poetryLockPath);
  if (content === null) return { nodes: [], edges: [], present: false };
  const packages = parsePoetryLock(content);
  const declared = readPoetryDeclared(projectPath);
  const nodes: DependencyNode[] = [];
  const byId = new Map<string, DependencyNode>();
  const byName = new Map<string, DependencyNode>();
  for (const pkg of packages) {
    collectPoetryPackage({ pkg, declared, nodes, byId, byName });
  }
  const edges = buildRootEdges(declared, byName);
  return { nodes, edges, present: true };
}

/** 读取 pyproject.toml 声明（dependencies + devDependencies） */
function readPoetryDeclared(projectPath: string): Map<string, string> {
  const pyprojectContent = readTextSafe(safeJoin(projectPath, 'pyproject.toml'));
  if (pyprojectContent === null) return new Map<string, string>();
  const parsed = parsePyproject(pyprojectContent);
  return new Map<string, string>([...parsed.dependencies, ...parsed.devDependencies]);
}

/** collectPoetryPackage 参数对象 */
interface CollectPoetryPackageParams {
  /** poetry.lock 包（name + version） */
  readonly pkg: { name: string; version: string };
  /** pyproject.toml 声明（name → 范围） */
  readonly declared: Map<string, string>;
  /** 节点收集目标 */
  readonly nodes: DependencyNode[];
  /** 节点索引（id → node） */
  readonly byId: Map<string, DependencyNode>;
  /** 名称索引（name → node） */
  readonly byName: Map<string, DependencyNode>;
}

/** 单个 poetry.lock 包 → 节点（直接依赖标记 + 根边） */
function collectPoetryPackage(params: CollectPoetryPackageParams): void {
  const { pkg, declared, nodes, byId, byName } = params;
  const isDirect = declared.has(pkg.name);
  const range = declared.get(pkg.name) ?? '';
  const id = `${pkg.name}@${pkg.version}`;
  if (byId.has(id)) return;
  const node = makeNode({
    name: pkg.name,
    version: pkg.version,
    declaredRange: range,
    kind: isDirect ? 'direct' : 'transitive',
    trust: 'unknown',
  });
  nodes.push(node);
  byId.set(id, node);
  if (isDirect && !byName.has(pkg.name)) byName.set(pkg.name, node);
}

/** Pipfile.lock 图谱：全部为直接依赖（锁定版本来自 version 字段） */
export function buildPipfileGraph(pipfilePath: string): BuildResult {
  const content = readTextSafe(pipfilePath);
  if (content === null) return { nodes: [], edges: [], present: false };
  const packages = parsePipfileLock(content);

  const nodes: DependencyNode[] = [];
  const byId = new Map<string, DependencyNode>();
  const edges: DependencyEdge[] = [];

  for (const pkg of packages) {
    const version = versionFromConstraint(pkg.declaredRange);
    const id = `${pkg.name}@${version}`;
    if (byId.has(id)) continue;
    const node = makeNode({
      name: pkg.name,
      version,
      declaredRange: pkg.declaredRange,
      kind: 'direct',
      trust: 'unknown',
    });
    nodes.push(node);
    byId.set(id, node);
    edges.push({ from: ROOT_NODE_ID, to: id, requirement: pkg.declaredRange });
  }

  return { nodes, edges, present: true };
}

/** pyproject.toml（无锁文件）图谱：全部为直接依赖 */
export function buildPyprojectGraph(pyprojectPath: string): BuildResult {
  const content = readTextSafe(pyprojectPath);
  if (content === null) return { nodes: [], edges: [], present: false };
  const parsed = parsePyproject(content);
  const declared = new Map<string, string>([...parsed.dependencies, ...parsed.devDependencies]);

  const nodes: DependencyNode[] = [];
  const byId = new Map<string, DependencyNode>();
  const edges: DependencyEdge[] = [];

  for (const [name, constraint] of declared) {
    const version = versionFromConstraint(constraint);
    const id = `${name}@${version}`;
    if (byId.has(id)) continue;
    const node = makeNode({
      name,
      version,
      declaredRange: constraint,
      kind: 'direct',
      trust: 'unknown',
    });
    nodes.push(node);
    byId.set(id, node);
    edges.push({ from: ROOT_NODE_ID, to: id, requirement: constraint });
  }

  return { nodes, edges, present: false };
}

/** requirements.txt 图谱：全部为直接依赖 */
export function buildRequirementsGraph(requirementsPath: string): BuildResult {
  const content = readTextSafe(requirementsPath);
  if (content === null) return { nodes: [], edges: [], present: false };
  const packages = parseRequirements(content);

  const nodes: DependencyNode[] = [];
  const byId = new Map<string, DependencyNode>();
  const edges: DependencyEdge[] = [];

  for (const pkg of packages) {
    const version = versionFromConstraint(pkg.constraint);
    const id = `${pkg.name}@${version}`;
    if (byId.has(id)) continue;
    const node = makeNode({
      name: pkg.name,
      version,
      declaredRange: pkg.constraint,
      kind: 'direct',
      trust: 'unknown',
    });
    nodes.push(node);
    byId.set(id, node);
    edges.push({ from: ROOT_NODE_ID, to: id, requirement: pkg.constraint });
  }

  return { nodes, edges, present: false };
}
