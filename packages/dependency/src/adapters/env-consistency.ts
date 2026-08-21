/**
 * 环境一致性检查器（env-consistency.ts）
 *
 * 纯离线静态比对项目声明的运行环境与实际配置，输出 EnvConsistencyReport。
 * 不联网、不执行安装命令；解析失败按缺失处理，绝不抛异常。
 *
 * 检查四类环境偏差：
 * - lockfile-drift：package.json 声明范围 vs 锁文件解析版本（不满足范围 → error）
 * - runtime-version：.nvmrc / .node-version / engines.node / .tool-versions 相互矛盾（矛盾 → error，单源 → info）
 * - env-file-diff：.env.example 声明键 vs .env 实际键（缺键 → warning，多余 → info）
 * - ci-vs-local：.github/workflows/*.yml 中 Node / 包管理器版本 vs 本地清单（不一致 → warning，无 CI → 不产出）
 */
import * as fs from 'fs';
import * as path from 'path';
import { load as loadYaml } from 'js-yaml';

/** 项目语言（与 pipeline 的 ProjectLanguage 结构对齐，本地定义不跨包引用） */
export type ProjectLanguage = 'typescript' | 'javascript' | 'python' | 'unknown';

/** 包管理器（与 pipeline 的 PackageManager 结构对齐） */
export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'pip' | 'poetry' | 'uv' | 'pipenv' | 'unknown';

/**
 * 项目画像：仅消费 projectPath 定位清单文件。
 * 本地结构类型，与 @zh/pipeline 的 ProjectProfile 形状一致，但不跨包 import。
 */
export interface ProjectProfile {
  projectPath: string;
  language: ProjectLanguage;
  framework: string | null;
  packageManager: PackageManager;
  hasTypeScript: boolean;
}

/** 环境一致性检查选项：projectRoot 为清单所在目录（默认取 profile.projectPath） */
export interface EnvConsistencyOptions {
  projectRoot: string;
}

/** 环境一致性报告：entries 为空数组表示无任何偏差 */
export interface EnvConsistencyReport {
  entries: EnvEntry[];
}

/** 单条环境偏差条目 */
export interface EnvEntry {
  /** 偏差类别 */
  kind: 'lockfile-drift' | 'runtime-version' | 'env-file-diff' | 'ci-vs-local';
  /** 条目名称（包名 / 运行时 / 环境变量 / 工作流） */
  name: string;
  /** 期望值（声明 / 示例 / 本地清单） */
  expected: string;
  /** 实际值（锁文件 / 文件内容 / CI 配置） */
  actual: string;
  /** 严重度：error=阻断，warning=提示，info=信息 */
  severity: 'error' | 'warning' | 'info';
  /** 人类可读说明（UI 直接展示） */
  detail: string;
}

/** 环境一致性检查器契约（对齐规格附 B.3(4) ④） */
export interface EnvConsistencyChecker {
  check(profile: ProjectProfile, options?: EnvConsistencyOptions): Promise<EnvConsistencyReport>;
}

/** 判断值是否为普通对象（非 null、非数组） */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 安全读取 JSON 文件；解析失败返回 null */
function readJsonSafe(filePath: string): Record<string, unknown> | null {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return isRecord(data) ? data : null;
  } catch {
    // 无法解析时按缺失处理
    return null;
  }
}

/** 安全读取 YAML 文件；解析失败返回 null */
function readYamlSafe(filePath: string): unknown {
  try {
    return loadYaml(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    // 无法解析时按缺失处理
    return null;
  }
}

/** 安全读取文本文件；读取失败返回 null */
function readTextSafe(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    // 无法读取时按缺失处理
    return null;
  }
}

/** 去除版本号前后空白与首尾 v 前缀（'  v18.20.2\n' → '18.20.2'） */
function normalizeVersion(raw: string): string {
  return raw.trim().replace(/^v/i, '');
}

/**
 * 判断锁定版本是否满足 package.json 声明范围（仅离线静态近似）：
 * - 精确版本 / ^x.y.z / ~x.y.z：比较主次补丁数字
 * - 通配（* / x / latest / workspace:*）：视为满足
 */
function satisfiesRange(range: string, version: string): boolean {
  const r = range.trim();
  if (r === '' || r === '*' || r === 'x' || r === 'latest' || r.includes('workspace:')) return true;

  const m = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return true;
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];

  const exact = r.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (exact) {
    return exact[1] === String(major) && exact[2] === String(minor) && exact[3] === String(patch);
  }

  const caret = r.match(/^\^(\d+)\.(\d+)\.(\d+)$/);
  if (caret) {
    const [cM, cm, cP] = [Number(caret[1]), Number(caret[2]), Number(caret[3])];
    if (cM !== major) return false;
    return cM > 0 ? minor >= cm : (minor === cm && patch >= cP) || minor > cm;
  }

  const tilde = r.match(/^~(\d+)\.(\d+)\.(\d+)$/);
  if (tilde) {
    return Number(tilde[1]) === major && Number(tilde[2]) === minor && patch >= Number(tilde[3]);
  }

  const star = r.match(/^[v~^]*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/);
  if (star) {
    const [sM, sm, sP] = [Number(star[1]), Number(star[2] ?? '0'), Number(star[3] ?? '0')];
    if (sM !== major) return false;
    if (star[2] === undefined) return true;
    if (sm !== minor) return false;
    if (star[3] === undefined) return true;
    return patch >= sP;
  }

  // 无法识别的范围（含 || 、>= 等）不做强判断
  return true;
}

/** package.json 直接依赖声明：name → 范围 */
function readDeclaredDeps(pkgJson: Record<string, unknown>): Map<string, string> {
  const declared = new Map<string, string>();
  for (const key of ['dependencies', 'devDependencies', 'optionalDependencies'] as const) {
    const section = pkgJson[key];
    if (!isRecord(section)) continue;
    for (const [name, range] of Object.entries(section)) {
      if (typeof range === 'string') declared.set(name, range);
    }
  }
  return declared;
}

/** npm 锁文件：packages 映射 + v1 dependencies 嵌套 → name → version */
function collectNpmVersions(lock: Record<string, unknown>): Map<string, string> {
  const versions = new Map<string, string>();
  const packages = lock.packages;
  if (isRecord(packages)) {
    for (const [key, meta] of Object.entries(packages)) {
      const m = key.match(/^node_modules\/(@[^/]+\/[^/]+|[^/]+)/);
      if (!m) continue;
      if (!isRecord(meta)) continue;
      if (typeof meta.version !== 'string') continue;
      if (!versions.has(m[1])) versions.set(m[1], meta.version);
    }
  }
  const deps = lock.dependencies;
  if (isRecord(deps)) {
    const walk = (section: Record<string, unknown>): void => {
      for (const [name, meta] of Object.entries(section)) {
        if (!isRecord(meta)) continue;
        if (typeof meta.version === 'string' && !versions.has(name)) versions.set(name, meta.version);
        const nested = meta.dependencies;
        if (isRecord(nested)) walk(nested);
      }
    };
    walk(deps);
  }
  return versions;
}

/** pnpm 锁文件：importers 直接依赖 → name → 锁定版本 */
function collectPnpmVersions(lock: Record<string, unknown>): Map<string, string> {
  const versions = new Map<string, string>();
  const importers = lock.importers;
  if (!isRecord(importers)) return versions;
  const rootImporter = importers['.'] ?? Object.values(importers)[0];
  if (!isRecord(rootImporter)) return versions;
  for (const sectionKey of ['dependencies', 'devDependencies', 'optionalDependencies'] as const) {
    const section = rootImporter[sectionKey];
    if (!isRecord(section)) continue;
    for (const [name, meta] of Object.entries(section)) {
      if (!isRecord(meta)) continue;
      if (typeof meta.version !== 'string') continue;
      versions.set(name, meta.version.split('(')[0]);
    }
  }
  return versions;
}

/** yarn.lock v1 块式解析 → name → 锁定版本 */
function collectYarnVersions(content: string): Map<string, string> {
  const versions = new Map<string, string>();
  let currentName: string | null = null;
  for (const rawLine of content.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const indent = rawLine.match(/^\s*/)?.[0].length ?? 0;
    if (indent === 0 && trimmed.endsWith(':')) {
      let keysText = trimmed.slice(0, -1).trim();
      if (keysText.length >= 2 && keysText.startsWith('"') && keysText.endsWith('"')) {
        keysText = keysText.slice(1, -1);
      }
      const first = keysText.split(',')[0].trim();
      const m = first.match(/^(@[^/]+\/)?([^@]+)@/);
      currentName = m ? `${m[1] ?? ''}${m[2]}` : null;
      continue;
    }
    if (currentName && trimmed.startsWith('version ')) {
      let value = trimmed.slice('version'.length).trim();
      if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
      if (!versions.has(currentName)) versions.set(currentName, value);
      currentName = null;
    }
  }
  return versions;
}

/** 锁文件漂移检查：声明范围 vs 锁文件解析版本 */
function checkLockfileDrift(projectRoot: string, pkgJson: Record<string, unknown> | null): EnvEntry[] {
  if (!pkgJson) return [];
  const declared = readDeclaredDeps(pkgJson);
  if (declared.size === 0) return [];

  let resolved: Map<string, string> | null = null;

  const pnpmPath = path.join(projectRoot, 'pnpm-lock.yaml');
  const npmPath = path.join(projectRoot, 'package-lock.json');
  const yarnPath = path.join(projectRoot, 'yarn.lock');

  if (fs.existsSync(pnpmPath)) {
    const lock = readYamlSafe(pnpmPath);
    if (isRecord(lock)) resolved = collectPnpmVersions(lock);
  } else if (fs.existsSync(npmPath)) {
    const lock = readJsonSafe(npmPath);
    if (lock) resolved = collectNpmVersions(lock);
  } else if (fs.existsSync(yarnPath)) {
    const content = readTextSafe(yarnPath);
    if (content !== null) resolved = collectYarnVersions(content);
  }

  if (!resolved) return [];

  const entries: EnvEntry[] = [];
  for (const [name, range] of declared) {
    const locked = resolved.get(name);
    if (locked === undefined) continue;
    if (satisfiesRange(range, locked)) continue;
    entries.push({
      kind: 'lockfile-drift',
      name,
      expected: range,
      actual: locked,
      severity: 'error',
      detail: `package.json 声明 ${name}@${range}，锁文件锁定 ${locked}，不在声明范围内`,
    });
  }
  return entries;
}

/** 运行时版本源：来源名称 + 原始声明 */
interface RuntimeSource {
  source: string;
  value: string;
}

/** 收集运行时版本来源：.nvmrc / .node-version / engines.node / .tool-versions */
function collectRuntimeSources(projectRoot: string, pkgJson: Record<string, unknown> | null): RuntimeSource[] {
  const sources: RuntimeSource[] = [];

  for (const file of ['.nvmrc', '.node-version']) {
    const content = readTextSafe(path.join(projectRoot, file));
    if (content === null) continue;
    const firstLine = content.split(/\r?\n/).find((line) => line.trim() !== '');
    if (firstLine) sources.push({ source: file, value: normalizeVersion(firstLine) });
  }

  if (pkgJson) {
    const engines = pkgJson.engines;
    if (isRecord(engines) && typeof engines.node === 'string') {
      sources.push({ source: 'package.json engines.node', value: engines.node.trim() });
    }
  }

  const toolVersions = readTextSafe(path.join(projectRoot, '.tool-versions'));
  if (toolVersions !== null) {
    for (const rawLine of toolVersions.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line === '' || line.startsWith('#')) continue;
      const parts = line.split(/\s+/);
      if (parts[0] === 'nodejs' && parts[1]) {
        sources.push({ source: '.tool-versions (nodejs)', value: normalizeVersion(parts[1]) });
      }
    }
  }

  return sources;
}

/** 运行时版本一致性检查：多源矛盾 → error；仅单源 → info */
function checkRuntimeVersion(projectRoot: string, pkgJson: Record<string, unknown> | null): EnvEntry[] {
  const sources = collectRuntimeSources(projectRoot, pkgJson);
  if (sources.length === 0) return [];

  const entries: EnvEntry[] = [];
  const first = sources[0];

  if (sources.length === 1) {
    entries.push({
      kind: 'runtime-version',
      name: 'node',
      expected: `${first.source}: ${first.value}`,
      actual: '（仅有此一处来源）',
      severity: 'info',
      detail: `运行时版本仅由 ${first.source} 声明（${first.value}），缺少其他来源交叉验证`,
    });
    return entries;
  }

  for (let i = 1; i < sources.length; i++) {
    const source = sources[i];
    if (normalizeVersion(source.value) === normalizeVersion(first.value)) continue;
    entries.push({
      kind: 'runtime-version',
      name: 'node',
      expected: `${first.source}: ${first.value}`,
      actual: `${source.source}: ${source.value}`,
      severity: 'error',
      detail: `${first.source} 与 ${source.source} 声明的 Node 版本不一致`,
    });
  }
  return entries;
}

/** 解析 .env 文件为键集合（支持 # 注释与 KEY=VALUE 形式） */
function parseEnvKeys(content: string): string[] {
  const keys: string[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const key = line.split('=')[0]?.trim();
    if (key && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) keys.push(key);
  }
  return keys;
}

/** 环境变量文件差异检查：.env.example 键 vs .env 键 */
function checkEnvFileDiff(projectRoot: string): EnvEntry[] {
  const examplePath = path.join(projectRoot, '.env.example');
  const exampleContent = readTextSafe(examplePath);
  if (exampleContent === null) return [];

  const exampleKeys = new Set(parseEnvKeys(exampleContent));
  const envPath = path.join(projectRoot, '.env');
  const envContent = readTextSafe(envPath);
  const envKeys = new Set(envContent === null ? [] : parseEnvKeys(envContent));

  const entries: EnvEntry[] = [];
  for (const key of exampleKeys) {
    if (envKeys.has(key)) continue;
    entries.push({
      kind: 'env-file-diff',
      name: key,
      expected: '.env.example 已声明',
      actual: '.env 缺失',
      severity: 'warning',
      detail: `.env 缺少 .env.example 中声明的环境变量 ${key}`,
    });
  }
  for (const key of envKeys) {
    if (exampleKeys.has(key)) continue;
    entries.push({
      kind: 'env-file-diff',
      name: key,
      expected: '（.env.example 未声明）',
      actual: '.env 中多余',
      severity: 'info',
      detail: `.env 存在 .env.example 未声明的环境变量 ${key}`,
    });
  }
  return entries;
}

/** CI 工作流配置：工作流文件名 + Node 版本 + 包管理器版本 */
interface CiWorkflowInfo {
  file: string;
  nodeVersion: string | null;
  packageManager: string | null;
}

/** 从字符串值中提取版本号（'node-version: 20' → '20'，'18.20.2' → '18.20.2'） */
function extractVersion(value: string): string | null {
  const m = value.match(/(\d+)(?:\.\d+){0,2}/);
  return m ? m[0] : null;
}

/** 读取 .github/workflows/*.yml 中声明的 Node / 包管理器版本 */
function readCiWorkflows(projectRoot: string): CiWorkflowInfo[] {
  const workflowsDir = path.join(projectRoot, '.github', 'workflows');
  let files: string[];
  try {
    files = fs.readdirSync(workflowsDir).filter((f) => /\.ya?ml$/i.test(f));
  } catch {
    // 无 workflows 目录：视为无 CI
    return [];
  }

  const infos: CiWorkflowInfo[] = [];
  for (const file of files) {
    const data = readYamlSafe(path.join(workflowsDir, file));
    if (!isRecord(data)) continue;
    const jobs = data.jobs;
    if (!isRecord(jobs)) continue;

    let nodeVersion: string | null = null;
    let packageManager: string | null = null;

    const scanStep = (step: unknown): void => {
      if (!isRecord(step)) return;
      const uses = typeof step.uses === 'string' ? step.uses : '';
      if (uses.startsWith('actions/setup-node')) {
        const withBlock = step.with;
        if (isRecord(withBlock)) {
          if (typeof withBlock['node-version'] === 'string') {
            nodeVersion = extractVersion(withBlock['node-version']) ?? withBlock['node-version'].trim();
          } else if (typeof withBlock['node-version-file'] === 'string') {
            nodeVersion = `@${withBlock['node-version-file']}`;
          }
        }
      }
      const withBlock = step.with;
      if (isRecord(withBlock) && typeof withBlock['package-manager'] === 'string') {
        packageManager = withBlock['package-manager'].trim();
      }
    };

    const scanJob = (job: unknown): void => {
      if (!isRecord(job)) return;
      const steps = job.steps;
      if (Array.isArray(steps)) steps.forEach(scanStep);
      const strategy = job.strategy;
      if (isRecord(strategy)) {
        const matrix = strategy.matrix;
        if (isRecord(matrix) && typeof matrix['node-version'] === 'string') {
          nodeVersion = extractVersion(matrix['node-version']) ?? matrix['node-version'].trim();
        }
      }
    };

    for (const job of Object.values(jobs)) {
      if (isRecord(job)) scanJob(job);
      else if (Array.isArray(job)) job.forEach(scanJob);
    }

    infos.push({ file, nodeVersion, packageManager });
  }
  return infos;
}

/** CI 与本地清单一致性检查：无 CI 工作流时不产出 */
function checkCiVsLocal(
  projectRoot: string,
  pkgJson: Record<string, unknown> | null,
  profile: ProjectProfile,
): EnvEntry[] {
  const workflows = readCiWorkflows(projectRoot);
  if (workflows.length === 0) return [];

  let localNode: string | null = null;
  if (pkgJson) {
    const engines = pkgJson.engines;
    if (isRecord(engines) && typeof engines.node === 'string') {
      localNode = extractVersion(engines.node);
    }
  }
  const runtime = collectRuntimeSources(projectRoot, pkgJson);
  if (localNode === null) {
    const nvmrc = runtime.find((s) => s.source === '.nvmrc' || s.source === '.node-version');
    if (nvmrc) localNode = extractVersion(nvmrc.value);
  }

  const localPackageManager: string | null =
    profile.packageManager === 'unknown' ? null : profile.packageManager;

  const entries: EnvEntry[] = [];
  for (const workflow of workflows) {
    if (workflow.nodeVersion !== null && localNode !== null && workflow.nodeVersion !== localNode) {
      entries.push({
        kind: 'ci-vs-local',
        name: `${workflow.file} node`,
        expected: `本地 ${localNode}`,
        actual: `CI ${workflow.nodeVersion}`,
        severity: 'warning',
        detail: `工作流 ${workflow.file} 使用 Node ${workflow.nodeVersion}，本地清单声明 ${localNode}`,
      });
    }
    if (workflow.packageManager !== null && localPackageManager !== null && workflow.packageManager !== localPackageManager) {
      entries.push({
        kind: 'ci-vs-local',
        name: `${workflow.file} package-manager`,
        expected: `本地 ${localPackageManager}`,
        actual: `CI ${workflow.packageManager}`,
        severity: 'warning',
        detail: `工作流 ${workflow.file} 使用包管理器 ${workflow.packageManager}，本地为 ${localPackageManager}`,
      });
    }
  }
  return entries;
}

/**
 * 环境一致性检查器实现。
 *
 * 纯离线静态分析：只读清单 / 锁文件 / 环境文件 / CI 配置，
 * 任何文件缺失或解析失败都跳过对应检查类别，绝不抛异常。
 */
export class EnvConsistencyCheckerImpl implements EnvConsistencyChecker {
  /** 执行环境一致性检查（离线静态，永不抛异常） */
  async check(profile: ProjectProfile, options?: EnvConsistencyOptions): Promise<EnvConsistencyReport> {
    const projectRoot = options?.projectRoot ?? profile.projectPath;

    const pkgJson = readJsonSafe(path.join(projectRoot, 'package.json'));
    const entries: EnvEntry[] = [
      ...checkLockfileDrift(projectRoot, pkgJson),
      ...checkRuntimeVersion(projectRoot, pkgJson),
      ...checkEnvFileDiff(projectRoot),
      ...checkCiVsLocal(projectRoot, pkgJson, profile),
    ];
    return { entries };
  }
}
