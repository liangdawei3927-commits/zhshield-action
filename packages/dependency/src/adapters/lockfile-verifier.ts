/**
 * 锁文件完整性校验器（lockfile-verifier.ts）
 *
 * 离线静态校验项目锁文件与清单声明的一致性：
 * - 探测锁文件类型（npm / pnpm / yarn / pip）
 * - 对比清单声明范围与锁文件锁定版本（手写 semver 范围匹配器，零新依赖）
 * - 检测完整性字段缺失 / 校验和异常
 *
 * 零网络请求、不执行安装命令；解析失败按缺失/已修改处理，绝不抛异常。
 */
import * as fs from 'fs';
import { safeJoin } from '@zh/shared';
import {
  isRecord,
  readYamlSafe,
  readTextSafe,
  parseYarnLock,
  readPnpmImporterEntries,
  type YarnBlock,
} from '../lockfile-utils';
import { satisfiesVersion } from './lockfile-verifier-semver';
import {
  parseNpmLock,
  parsePipfileLockFile,
  parsePoetryProject,
  createParsedLockfile,
  readDeclaredRanges,
  type ParsedLockfile,
} from './lockfile-verifier-parsers';

export { satisfiesVersion } from './lockfile-verifier-semver';

// ────────────────────────────── 模块级正则常量（避免每次调用重编译） ──────────────────────────────

/** pnpm-lock.yaml packages 键 */
const PNPM_PACKAGE_KEY_RE = /^\/?(@[^/]+\/[^/]+|[^/@]+)@(.+)$/;
/** pnpm 本地 workspace 引用前缀：file: / link: / workspace: */
const PNPM_LOCAL_REF_PREFIX_RE = /^(file|link|workspace):/;
/** pnpm 本地目录/链接类型 resolution（本地包天然无 integrity） */
const LOCAL_RESOLUTION_TYPES = new Set(['directory', 'link', 'workspace']);

/** 锁文件校验器契约：离线静态校验，不联网 */
export interface LockfileVerifier {
  verify(projectRoot: string, options?: LockfileVerifierOptions): Promise<LockfileVerification>;
}

/** 校验选项（当前仅支持完整性基线比对） */
export interface LockfileVerifierOptions {
  /** 期望的完整性基线：nodeId（name@version）→ 期望 integrity，与锁文件实际值比对 */
  expectedIntegrity?: Record<string, string>;
}

/** 锁文件校验结果 */
export interface LockfileVerification {
  /** clean：全部声明满足且完整性通过；modified：存在不一致；missing：未发现锁文件 */
  status: 'clean' | 'modified' | 'missing';
  /** 命中的锁文件绝对路径（status 为 missing 时缺省） */
  lockfilePath?: string;
  /** 声明范围与锁定版本不一致的直接依赖明细 */
  diffs: LockfileDiff[];
  /** 完整性异常描述（缺失 / 校验和不匹配） */
  integrityFailures: string[];
}

/** 单个直接依赖的声明-锁定版本差异 */
export interface LockfileDiff {
  name: string;
  /** 清单声明的版本范围，如 '^4.17.21' */
  declaredVersion: string;
  /** 锁文件锁定的实际版本，如 '4.17.21'；未在锁文件中出现时为 '' */
  lockedVersion: string;
}

// ────────────────────────────── 锁文件 / 清单解析 ──────────────────────────────

/** pnpm / yarn 生态解析（npm / poetry / pipfile 解析已拆分至 lockfile-verifier-parsers.ts） */

/** pnpm-lock.yaml → importers 声明范围 + packages 完整性 */
function parsePnpmLock(projectRoot: string, lockfilePath: string): ParsedLockfile {
  const failures: string[] = [];
  const { declared, locked, integrity } = createParsedLockfile(
    new Map<string, string>(),
    failures,
  );

  if (!fs.existsSync(safeJoin(projectRoot, 'package.json'))) {
    failures.push('缺少 package.json 清单');
  }

  const data = readYamlSafe(lockfilePath);
  if (!isRecord(data)) {
    failures.push('pnpm-lock.yaml 解析失败，无法校验');
    return { declared, locked, integrity, failures };
  }

  collectPnpmPackages(data, locked, integrity, failures);
  collectPnpmImporters(data, declared, locked);
  return { declared, locked, integrity, failures };
}

/** packages 区块：解析锁定版本与 resolution.integrity */
function collectPnpmPackages(
  data: Record<string, unknown>,
  locked: Map<string, string>,
  integrity: Map<string, string>,
  failures: string[],
): void {
  const packages = data.packages;
  if (!isRecord(packages)) return;
  for (const [key, meta] of Object.entries(packages)) {
    const m = key.match(PNPM_PACKAGE_KEY_RE);
    if (!m) continue;
    if (!isRecord(meta)) continue;
    const name = m[1];
    const version = m[2].split('(')[0];
    if (!version) continue;
    const resolution = isRecord(meta.resolution) ? meta.resolution : undefined;
    const integrityValue =
      typeof resolution?.integrity === 'string'
        ? resolution.integrity
        : typeof meta.integrity === 'string'
          ? meta.integrity
          : '';
    if (integrityValue === '') {
      const isLocalPackage =
        PNPM_LOCAL_REF_PREFIX_RE.test(version) ||
        (resolution !== undefined &&
          typeof resolution.type === 'string' &&
          LOCAL_RESOLUTION_TYPES.has(resolution.type));
      if (!isLocalPackage) {
        failures.push(`[pnpm] ${name}@${version} 缺少 resolution.integrity 完整性字段`);
      }
    } else {
      integrity.set(`${name}@${version}`, integrityValue);
    }
  }
}

/** importers 区块：根 importer 的声明范围与锁定版本 */
function collectPnpmImporters(
  data: Record<string, unknown>,
  declared: Map<string, string>,
  locked: Map<string, string>,
): void {
  for (const entry of readPnpmImporterEntries(data, ['dependencies', 'devDependencies'])) {
    if (entry.version === '') continue;
    if (
      PNPM_LOCAL_REF_PREFIX_RE.test(entry.specifier) ||
      PNPM_LOCAL_REF_PREFIX_RE.test(entry.version)
    )
      continue;
    declared.set(entry.name, entry.specifier);
    locked.set(entry.name, entry.version);
  }
}

/** yarn 块键解析：name@range → { name, range }（支持 @scope/name@range） */
const YARN_KEY_RE = /^(@[^/]+\/)?([^@]+)@(.*)$/;

/** yarn.lock v1 → package.json 声明范围 + 块锁定版本 */
function parseYarnLockFile(projectRoot: string, lockfilePath: string): ParsedLockfile {
  const failures: string[] = [];
  const declared = readDeclaredRanges(projectRoot, failures);
  const { locked, integrity } = createParsedLockfile(declared, failures);

  const content = readTextSafe(lockfilePath);
  if (content === null) {
    failures.push('yarn.lock 读取失败，无法校验');
    return { declared, locked, integrity, failures };
  }

  for (const block of parseYarnLock(content)) {
    collectYarnBlock(block, locked, integrity, failures);
  }
  return { declared, locked, integrity, failures };
}

/** 单个 yarn 块：锁定版本 + 完整性（缺失 integrity 记入 failures） */
function collectYarnBlock(
  block: YarnBlock,
  locked: Map<string, string>,
  integrity: Map<string, string>,
  failures: string[],
): void {
  const version = block.fields.get('version');
  if (!version) return;
  for (const key of block.keys) {
    const m = key.trim().match(YARN_KEY_RE);
    if (!m) continue;
    const scope = m[1] ?? '';
    const name = `${scope}${m[2]}`;
    if (!locked.has(name)) locked.set(name, version);
    const integrityValue = block.fields.get('integrity') ?? '';
    if (integrityValue === '') {
      failures.push(`[yarn] ${name}@${version} 缺少 integrity 完整性字段`);
    } else if (!integrity.has(`${name}@${version}`)) {
      integrity.set(`${name}@${version}`, integrityValue);
    }
  }
}

// ────────────────────────────── 校验器实现 ──────────────────────────────

/** 锁文件校验器具体实现：离线静态，绝不抛异常 */
export class LockfileVerifierImpl implements LockfileVerifier {
  async verify(
    projectRoot: string,
    options?: LockfileVerifierOptions,
  ): Promise<LockfileVerification> {
    const found = detectLockfile(projectRoot);
    if (!found) {
      return { status: 'missing', diffs: [], integrityFailures: [] };
    }

    const lockfilePath = safeJoin(projectRoot, found.file);
    const parsed = found.parser();
    const integrityFailures = [...parsed.failures];
    checkExpectedIntegrity(options, parsed.integrity, integrityFailures, found.kind);
    const diffs = buildDiffs(parsed.declared, parsed.locked);
    const status: LockfileVerification['status'] =
      diffs.length > 0 || integrityFailures.length > 0 ? 'modified' : 'clean';
    return { status, lockfilePath, diffs, integrityFailures };
  }
}

/** 探测锁文件（与图谱构建器探测优先级一致：pnpm → npm → yarn → poetry → Pipfile） */
function detectLockfile(
  projectRoot: string,
): { kind: string; file: string; parser: () => ParsedLockfile } | null {
  const candidates: Array<{ kind: string; file: string; parser: () => ParsedLockfile }> = [
    {
      kind: 'pnpm',
      file: 'pnpm-lock.yaml',
      parser: () => parsePnpmLock(projectRoot, safeJoin(projectRoot, 'pnpm-lock.yaml')),
    },
    {
      kind: 'npm',
      file: 'package-lock.json',
      parser: () => parseNpmLock(projectRoot, safeJoin(projectRoot, 'package-lock.json')),
    },
    {
      kind: 'yarn',
      file: 'yarn.lock',
      parser: () => parseYarnLockFile(projectRoot, safeJoin(projectRoot, 'yarn.lock')),
    },
    {
      kind: 'poetry',
      file: 'poetry.lock',
      parser: () => parsePoetryProject(projectRoot, safeJoin(projectRoot, 'poetry.lock')),
    },
    {
      kind: 'pipfile',
      file: 'Pipfile.lock',
      parser: () => parsePipfileLockFile(safeJoin(projectRoot, 'Pipfile.lock')),
    },
  ];
  return candidates.find((c) => fs.existsSync(safeJoin(projectRoot, c.file))) ?? null;
}

/** 完整性基线比对（options.expectedIntegrity） */
function checkExpectedIntegrity(
  options: LockfileVerifierOptions | undefined,
  integrity: Map<string, string>,
  integrityFailures: string[],
  kind: string,
): void {
  if (!options?.expectedIntegrity) return;
  for (const [nodeId, expected] of Object.entries(options.expectedIntegrity)) {
    const actual = integrity.get(nodeId);
    if (actual !== undefined && actual !== expected) {
      integrityFailures.push(`[${kind}] ${nodeId} 校验和不匹配：期望 ${expected}，实际 ${actual}`);
    }
  }
}

/** 声明范围 vs 锁定版本 */
function buildDiffs(declared: Map<string, string>, locked: Map<string, string>): LockfileDiff[] {
  const diffs: LockfileDiff[] = [];
  for (const [name, range] of declared) {
    const lockedVersion = locked.get(name);
    if (lockedVersion === undefined) {
      diffs.push({ name, declaredVersion: range, lockedVersion: '' });
    } else if (!satisfiesVersion(lockedVersion, range)) {
      diffs.push({ name, declaredVersion: range, lockedVersion });
    }
  }
  return diffs;
}

/** 便捷入口：同步语义的异步包装（实现为单例类实例方法） */
export const lockfileVerifier: LockfileVerifier = new LockfileVerifierImpl();
