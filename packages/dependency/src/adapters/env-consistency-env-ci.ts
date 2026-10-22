/**
 * 环境一致性检查 —— 环境文件差异与 CI 对照（env-consistency-env-ci.ts）
 *
 * 由 env-consistency.ts 拆出，覆盖两类偏差：
 * - env-file-diff：.env.example 声明键 vs .env 实际键（缺键 → warning，多余 → info）
 * - ci-vs-local：.github/workflows/*.yml 中 Node / 包管理器版本 vs 本地清单（不一致 → warning，无 CI → 不产出）
 *
 * 纯离线静态比对；解析失败按缺失处理，绝不抛异常。
 */
import * as fs from 'fs';
import { safeJoin, type ProjectProfile } from '@zh/shared';
import { isRecord, readYamlSafe, readTextSafe, NEWLINE_RE } from '../lockfile-utils';
import type { EnvEntry } from './env-consistency-types';
import { collectRuntimeSources } from './env-consistency-versions';

// ────────────────────────────── 模块级正则常量（避免每次调用重编译） ──────────────────────────────

/** 环境变量名校验 */
const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** 版本号提取（前 3 段） */
const VERSION_EXTRACT_RE = /(\d+)(?:\.\d+){0,2}/;
/** YAML 工作流文件名匹配 */
const YAML_FILE_RE = /\.ya?ml$/i;

/** 解析 .env 文件为键集合（支持 # 注释与 KEY=VALUE 形式） */
function parseEnvKeys(content: string): string[] {
  const keys: string[] = [];
  for (const rawLine of content.split(NEWLINE_RE)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const key = line.split('=')[0]?.trim();
    if (key && ENV_VAR_NAME_RE.test(key)) keys.push(key);
  }
  return keys;
}

/** 环境变量文件差异检查：.env.example 键 vs .env 键 */
export function checkEnvFileDiff(projectRoot: string): EnvEntry[] {
  const examplePath = safeJoin(projectRoot, '.env.example');
  const exampleContent = readTextSafe(examplePath);
  if (exampleContent === null) return [];

  const exampleKeys = new Set(parseEnvKeys(exampleContent));
  const envPath = safeJoin(projectRoot, '.env');
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
  const m = value.match(VERSION_EXTRACT_RE);
  return m ? m[0] : null;
}

/** 读取 .github/workflows/*.yml 中声明的 Node / 包管理器版本 */
function readCiWorkflows(projectRoot: string): CiWorkflowInfo[] {
  const files = listWorkflowFiles(projectRoot);
  const infos: CiWorkflowInfo[] = [];
  for (const file of files) {
    const info = scanWorkflowFile(safeJoin(projectRoot, '.github', 'workflows'), file);
    if (info) infos.push(info);
  }
  return infos;
}

/** 列出 workflows 目录下的 YAML 文件；目录缺失视为无 CI */
function listWorkflowFiles(projectRoot: string): string[] {
  const workflowsDir = safeJoin(projectRoot, '.github', 'workflows');
  try {
    return fs.readdirSync(workflowsDir).filter((f) => YAML_FILE_RE.test(f));
  } catch {
    return [];
  }
}

/** 扫描单个工作流文件，提取 Node / 包管理器版本 */
function scanWorkflowFile(workflowsDir: string, file: string): CiWorkflowInfo | null {
  const data = readYamlSafe(safeJoin(workflowsDir, file));
  if (!isRecord(data)) return null;
  const jobs = data.jobs;
  if (!isRecord(jobs)) return null;
  let nodeVersion: string | null = null;
  let packageManager: string | null = null;
  const scanStep = (step: unknown): void => {
    if (!isRecord(step)) return;
    const uses = typeof step.uses === 'string' ? step.uses : '';
    if (uses.startsWith('actions/setup-node')) {
      const withBlock = step.with;
      if (isRecord(withBlock)) {
        const version = extractSetupNodeVersion(withBlock);
        if (version !== null) nodeVersion = version;
      }
    }
    const withBlock = step.with;
    if (isRecord(withBlock) && typeof withBlock['package-manager'] === 'string') {
      packageManager = withBlock['package-manager'].trim();
    }
  };
  const scanJob = (job: unknown): void => {
    if (!isRecord(job)) return;
    scanJobSteps(job, scanStep);
    scanJobMatrix(job, (v) => {
      nodeVersion = v;
    });
  };
  for (const job of Object.values(jobs)) {
    if (isRecord(job)) scanJob(job);
    else if (Array.isArray(job)) job.forEach(scanJob);
  }
  return { file, nodeVersion, packageManager };
}

function scanJobSteps(job: Record<string, unknown>, scanStep: (step: unknown) => void): void {
  const steps = job.steps;
  if (Array.isArray(steps)) steps.forEach(scanStep);
}

function scanJobMatrix(job: Record<string, unknown>, setNodeVersion: (v: string) => void): void {
  const strategy = job.strategy;
  if (isRecord(strategy)) {
    const matrix = strategy.matrix;
    if (isRecord(matrix) && typeof matrix['node-version'] === 'string') {
      const v = extractVersion(matrix['node-version']) ?? matrix['node-version'].trim();
      setNodeVersion(v);
    }
  }
}

/** 从 setup-node 的 with 块提取 Node 版本（node-version 优先，其次 node-version-file） */
function extractSetupNodeVersion(withBlock: Record<string, unknown>): string | null {
  if (typeof withBlock['node-version'] === 'string') {
    return extractVersion(withBlock['node-version']) ?? withBlock['node-version'].trim();
  }
  if (typeof withBlock['node-version-file'] === 'string') {
    return `@${withBlock['node-version-file']}`;
  }
  return null;
}

/** CI 与本地清单一致性检查：无 CI 工作流时不产出 */
export function checkCiVsLocal(
  projectRoot: string,
  pkgJson: Record<string, unknown> | null,
  profile: ProjectProfile,
): EnvEntry[] {
  const workflows = readCiWorkflows(projectRoot);
  if (workflows.length === 0) return [];

  const localNode = resolveLocalNode(projectRoot, pkgJson);
  const localPackageManager: string | null =
    profile.packageManager === 'unknown' ? null : profile.packageManager;

  const entries: EnvEntry[] = [];
  for (const workflow of workflows) {
    addNodeMismatch(entries, workflow, localNode);
    addPackageManagerMismatch(entries, workflow, localPackageManager);
  }
  return entries;
}

function resolveLocalNode(
  projectRoot: string,
  pkgJson: Record<string, unknown> | null,
): string | null {
  let localNode: string | null = null;
  if (pkgJson) {
    const engines = pkgJson.engines;
    if (isRecord(engines) && typeof engines.node === 'string') {
      localNode = extractVersion(engines.node);
    }
  }
  if (localNode !== null) return localNode;
  const runtime = collectRuntimeSources(projectRoot, pkgJson);
  const nvmrc = runtime.find((s) => s.source === '.nvmrc' || s.source === '.node-version');
  if (nvmrc) localNode = extractVersion(nvmrc.value);
  return localNode;
}

function addNodeMismatch(
  entries: EnvEntry[],
  workflow: CiWorkflowInfo,
  localNode: string | null,
): void {
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
}

function addPackageManagerMismatch(
  entries: EnvEntry[],
  workflow: CiWorkflowInfo,
  localPackageManager: string | null,
): void {
  if (
    workflow.packageManager !== null &&
    localPackageManager !== null &&
    workflow.packageManager !== localPackageManager
  ) {
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
