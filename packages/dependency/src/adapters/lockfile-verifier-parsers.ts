/**
 * 锁文件生态解析器（lockfile-verifier-parsers.ts）
 *
 * 从 lockfile-verifier.ts 拆分而来的纯解析区段：
 * - npm package-lock.json（v1 / v2 / v3）
 * - pyproject.toml + poetry.lock
 * - Pipfile.lock
 *
 * pnpm / yarn 解析因与图谱构建器存在强制复用对，保留在 lockfile-verifier.ts 原文件中。
 */
import { safeJoin } from '@zh/shared';
import {
  isRecord,
  readJsonSafe,
  readTextSafe,
  versionFromConstraint,
  collectManifestRanges,
  collectPipfileLockDeps,
  collectPyprojectDependencies,
  readPoetryLockPackages,
} from '../lockfile-utils';

/** npm package-lock.json packages 键 */
const PACKAGE_KEY_RE = /^node_modules\/(@[^/]+\/[^/]+|[^/]+)/;

/** 各生态解析结果统一形态 */
export interface ParsedLockfile {
  declared: Map<string, string>;
  locked: Map<string, string>;
  integrity: Map<string, string>;
  failures: string[];
}

/** 新建各生态解析结果的统一初始形态（declared / failures 由调用方提供，其余映射在此新建） */
export function createParsedLockfile(
  declared: Map<string, string>,
  failures: string[],
): ParsedLockfile {
  return {
    declared,
    locked: new Map<string, string>(),
    integrity: new Map<string, string>(),
    failures,
  };
}

/** package.json 声明范围（dependencies + devDependencies） */
export function readDeclaredRanges(
  projectRoot: string,
  failures: string[],
): Map<string, string> {
  const data = readJsonSafe(safeJoin(projectRoot, 'package.json'));
  if (!data) {
    failures.push('缺少可解析的 package.json，无法核对声明范围');
    return new Map<string, string>();
  }
  return collectManifestRanges(data, ['dependencies', 'devDependencies']);
}

/** npm package-lock.json（v1 / v2 / v3）→ 声明范围 / 锁定版本 / 完整性 */
export function parseNpmLock(projectRoot: string, lockfilePath: string): ParsedLockfile {
  const failures: string[] = [];
  const declared = readDeclaredRanges(projectRoot, failures);
  const { locked, integrity } = createParsedLockfile(declared, failures);
  const lock = readJsonSafe(lockfilePath);
  if (!lock) {
    failures.push('package-lock.json 解析失败，无法校验');
    return { declared, locked, integrity, failures };
  }
  const lockfileVersion = lock.lockfileVersion;
  const isV1 =
    lockfileVersion === 1 ||
    (lockfileVersion === undefined && isRecord(lock.dependencies) && !isRecord(lock.packages));
  if (isV1) {
    collectNpmV1(lock, locked, integrity, failures);
    return { declared, locked, integrity, failures };
  }
  collectNpmPackages(lock, locked, integrity, failures);
  return { declared, locked, integrity, failures };
}

/** v1：dependencies 顶层即直接依赖（含 integrity） */
function collectNpmV1(
  lock: Record<string, unknown>,
  locked: Map<string, string>,
  integrity: Map<string, string>,
  failures: string[],
): void {
  const deps = lock.dependencies;
  if (!isRecord(deps)) return;
  for (const [name, meta] of Object.entries(deps)) {
    if (!isRecord(meta)) continue;
    const version = typeof meta.version === 'string' ? meta.version : '';
    if (version === '') continue;
    locked.set(name, version);
    const integrityValue = typeof meta.integrity === 'string' ? meta.integrity : '';
    if (integrityValue === '' && typeof meta.resolved !== 'string') {
      failures.push(`[npm] ${name}@${version} 缺少 integrity/resolved 完整性字段`);
    } else {
      integrity.set(
        `${name}@${version}`,
        integrityValue || (typeof meta.resolved === 'string' ? meta.resolved : ''),
      );
    }
  }
}

/** v2/v3：packages 映射，直接依赖取 node_modules/<name> */
function collectNpmPackages(
  lock: Record<string, unknown>,
  locked: Map<string, string>,
  integrity: Map<string, string>,
  failures: string[],
): void {
  const packages = lock.packages;
  if (!isRecord(packages)) {
    failures.push('package-lock.json packages 区块缺失，无法校验');
    return;
  }
  for (const [key, meta] of Object.entries(packages)) {
    const m = key.match(PACKAGE_KEY_RE);
    if (!m) continue;
    if (!isRecord(meta)) continue;
    const name = m[1];
    const version = typeof meta.version === 'string' ? meta.version : '';
    if (version === '') continue;
    if (!locked.has(name)) locked.set(name, version);
    const integrityValue = typeof meta.integrity === 'string' ? meta.integrity : '';
    if (integrityValue === '') {
      failures.push(`[npm] ${name}@${version} 缺少 integrity 完整性字段`);
    } else {
      integrity.set(`${name}@${version}`, integrityValue);
    }
  }
}

/** pyproject.toml + poetry.lock → 声明范围 + 锁定版本 */
export function parsePoetryProject(projectRoot: string, lockfilePath: string): ParsedLockfile {
  const failures: string[] = [];
  const { declared, locked, integrity } = createParsedLockfile(
    new Map<string, string>(),
    failures,
  );

  const pyprojectContent = readTextSafe(safeJoin(projectRoot, 'pyproject.toml'));
  if (pyprojectContent === null) {
    failures.push('缺少可解析的 pyproject.toml，无法核对声明范围');
  } else {
    collectPyprojectDependencies(pyprojectContent, declared);
  }

  const content = readTextSafe(lockfilePath);
  if (content === null) {
    failures.push('poetry.lock 读取失败，无法校验');
    return { declared, locked, integrity, failures };
  }
  for (const pkg of readPoetryLockPackages(content)) {
    if (!locked.has(pkg.name)) locked.set(pkg.name, pkg.version);
    if (!pkg.hasHashes) {
      failures.push(`[pip] ${pkg.name}@${pkg.version} 缺少 [files] 哈希校验字段`);
    }
  }
  return { declared, locked, integrity, failures };
}

/** Pipfile.lock：default / develop 区块，version 为声明范围，hashes 为完整性 */
export function parsePipfileLockFile(lockfilePath: string): ParsedLockfile {
  const failures: string[] = [];
  const { declared, locked, integrity } = createParsedLockfile(
    new Map<string, string>(),
    failures,
  );

  const data = readJsonSafe(lockfilePath);
  if (!data) {
    failures.push('Pipfile.lock 解析失败，无法校验');
    return { declared, locked, integrity, failures };
  }
  for (const entry of collectPipfileLockDeps(data)) {
    const { name, declaredRange: range } = entry;
    const lockedVersion = versionFromConstraint(range);
    declared.set(name, range);
    if (lockedVersion !== '') locked.set(name, lockedVersion);
    if (!entry.hasHashes) {
      failures.push(`[pip] ${name}@${lockedVersion} 缺少 hashes 哈希字段`);
    }
  }
  return { declared, locked, integrity, failures };
}
