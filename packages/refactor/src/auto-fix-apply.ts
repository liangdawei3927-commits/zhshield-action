/**
 * 一键应用自动修复的落盘支撑（auto-fix-apply.ts）
 *
 * `auto-fix.ts` 负责「生成编辑」，本文件负责「写盘前把目标文件整体备份」。
 * 二者共同支撑 `RefactorEngine.applyAutoFixes`：任何自动改写都先留可回滚副本，
 * 与垃圾清理（garbage clean / restore）同构 —— 破坏性动作必须可撤销。
 *
 * 边界：只备份**位于被扫描项目根之内**的文件；越界路径（`..` / 绝对路径）一律跳过，
 * 既不备份也不返回 —— 生成器本就不该产出项目外编辑，这里是最后一道防线。
 */
import * as fs from 'fs';
import * as path from 'path';
import { safeJoin } from '@zh/shared';
import type { Fix } from './types';

/** 备份根目录（相对被扫描项目根） */
const BACKUP_ROOT = ['.zhshield', 'backups'] as const;

/** 备份清单文件名（与备份文件同目录；无清单的备份目录视为不可自动恢复） */
const MANIFEST_NAME = 'manifest.json';

/**
 * 一次自动修复的备份清单。
 *
 * 为什么必须落盘而不是只留在返回值里：`applyAutoFixes` 的返回值只服务于"当场回滚"
 * 和"当前这次调用"；用户**事后**想撤销（关掉应用、明天再想撤）时，内存里的列表早就没了。
 * 把 files / createdFiles 写进备份目录，撤销能力才从"注释承诺"变成"磁盘上可验证的事实"。
 */
export interface AutoFixBackupManifest {
  version: 1;
  createdAt: string;
  /** 被扫描项目根的绝对路径（恢复时校验，防止把备份恢复到别的项目） */
  projectRoot: string;
  /** 相对项目根、已备份的文件（恢复时逐个写回） */
  files: string[];
  /** 本次修复**新建**的文件（绝对路径；恢复时删除） */
  createdFiles: string[];
}

/**
 * 原子写：同目录临时文件 + `rename`。
 *
 * 为什么不用 `fs.writeFileSync` 直写：它是"截断后写"，磁盘满 / IO 错误会留下**半截文件**
 * —— 对"一键修复用户代码"这种动作，半截源码比不改更糟。`rename` 在同一文件系统内是原子的：
 * 要么旧内容，要么完整新内容。
 */
export function atomicWriteFileSync(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  const tmp = path.join(
    dir,
    `.zhshield-tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  try {
    fs.writeFileSync(tmp, content, 'utf-8');
    fs.renameSync(tmp, filePath);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/** 从修复集合收集去重后的目标文件（绝对路径） */
export function collectFixTargetFiles(fixes: readonly Fix[]): string[] {
  const seen = new Set<string>();
  for (const fix of fixes) {
    for (const edit of fix.edits) seen.add(edit.filePath);
  }
  return [...seen];
}

/**
 * 判断相对路径是否安全地落在项目根内（非绝对、不逃逸到父目录）。
 *
 * 注意不能用 `rel.startsWith('..')`：目录名恰为 `..foo` 的合法路径（相对路径以
 * `..foo/` 开头）会被误判越界，导致「跳过备份却仍被写入」的不一致。正确判据是
 * 精确匹配父目录逃逸：`..` 单独、或以 `..<sep>` 开头。
 */
function isInsideProject(rel: string): boolean {
  if (rel === '' || path.isAbsolute(rel)) return false;
  if (rel === '..') return false;
  return !rel.startsWith('..' + path.sep);
}

/**
 * 判断绝对路径是否落在项目根内（写盘前的硬前置校验）。
 *
 * 与 {@link isInsideProject} 同源，供 `applyAutoFixes` 在真正写盘前拒绝越界目标，
 * 实现「生成器 bug 也不越界写」的防御纵深（代码审查报告3 P2-2）。
 */
export function isWithinProject(filePath: string, projectRoot: string): boolean {
  return isInsideProject(path.relative(projectRoot, filePath));
}

/** 备份单个文件到备份目录；成功返回相对路径，越界/不存在返回 null */
function backupOneFile(filePath: string, projectRoot: string, backupDir: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  const rel = path.relative(projectRoot, filePath);
  if (!isInsideProject(rel)) return null;
  const dest = safeJoin(backupDir, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(filePath, dest);
  return rel;
}

/**
 * 备份所有修复目标文件，并写入可事后恢复的清单。
 *
 * @param fixes 生成的修复编辑集合
 * @param projectRoot 被扫描项目根（绝对路径）
 * @param stamp 时间戳串（用于生成唯一备份目录名，调用方传入以便测试可控）
 * @returns 备份目录、已备份的相对路径列表、本次将新建的文件（绝对路径）
 */
export function backupFixTargets(
  fixes: readonly Fix[],
  projectRoot: string,
  stamp: string,
): { backupDir: string | null; backedUpFiles: string[]; createdFiles: string[] } {
  const targets = collectFixTargetFiles(fixes);
  if (targets.length === 0) return { backupDir: null, backedUpFiles: [], createdFiles: [] };
  const backupDir = path.join(projectRoot, ...BACKUP_ROOT, `refactor-autofix-${stamp}`);
  const backedUpFiles: string[] = [];
  const existingBefore = new Set<string>();
  for (const filePath of targets) {
    const rel = backupOneFile(filePath, projectRoot, backupDir);
    if (rel !== null) {
      backedUpFiles.push(rel);
      existingBefore.add(filePath);
    }
  }
  const createdFiles = targets.filter(
    (fp) => !existingBefore.has(fp) && isWithinProject(fp, projectRoot),
  );
  const manifest: AutoFixBackupManifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    projectRoot: path.resolve(projectRoot),
    files: backedUpFiles,
    createdFiles,
  };
  fs.mkdirSync(backupDir, { recursive: true });
  fs.writeFileSync(
    path.join(backupDir, MANIFEST_NAME),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf-8',
  );
  return { backupDir, backedUpFiles, createdFiles };
}

/** 读取备份清单；目录不存在或清单损坏返回 null（调用方据此报"不可恢复"而不是假装恢复成功） */
export function readBackupManifest(backupDir: string): AutoFixBackupManifest | null {
  try {
    const raw = fs.readFileSync(path.join(backupDir, MANIFEST_NAME), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<AutoFixBackupManifest>;
    if (
      parsed.version !== 1 ||
      !Array.isArray(parsed.files) ||
      typeof parsed.projectRoot !== 'string'
    ) {
      return null;
    }
    return {
      version: 1,
      createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : '',
      projectRoot: parsed.projectRoot,
      files: parsed.files.filter((f): f is string => typeof f === 'string'),
      createdFiles: Array.isArray(parsed.createdFiles)
        ? parsed.createdFiles.filter((f): f is string => typeof f === 'string')
        : [],
    };
  } catch {
    return null;
  }
}

/** 恢复结果：恢复了哪些文件、删除了哪些新建文件、是否逐字节校验通过 */
export interface RestoreBackupResult {
  restoredFiles: string[];
  removedFiles: string[];
  /** 恢复后逐文件与备份字节比对是否全部一致（false = 恢复不可信，调用方必须据此失败） */
  verified: boolean;
}

/**
 * 按清单恢复一次自动修复：把备份写回、删除本次新建的文件，并**逐字节校验**恢复结果。
 *
 * 为什么要校验：回滚是"安全网"，安全网自己悄悄失败是最坏的失败 —— 调用方会以为
 * 代码已复原而继续工作。校验不过就返回 verified:false，让上层明确报错。
 *
 * 幂等性（2026-11-04 实测驱动）：目标内容已与备份一致时**跳过写入**。否则"未改动过的文件"
 * 也会被重写一遍 —— 若它恰好位于只读目录，就会在毫无必要的情况下报"回滚失败"，
 * 把一次成功的回滚伪装成失败（测试用例真实踩到）。
 */
export function restoreFromBackup(backupDir: string): RestoreBackupResult {
  const manifest = readBackupManifest(backupDir);
  if (!manifest) {
    throw new Error(`备份目录不可恢复（缺少清单或清单损坏）：${backupDir}`);
  }
  const restoredFiles: string[] = [];
  let verified = true;
  for (const rel of manifest.files) {
    const outcome = restoreOneFile(backupDir, manifest.projectRoot, rel);
    if (outcome !== 'failed') restoredFiles.push(rel);
    if (outcome === 'failed' || outcome === 'missing') verified = false;
  }
  const removedFiles: string[] = [];
  for (const abs of manifest.createdFiles) {
    const outcome = removeOneFile(abs);
    if (outcome === 'failed') verified = false;
    if (outcome === 'removed') removedFiles.push(path.relative(manifest.projectRoot, abs));
  }
  return { restoredFiles, removedFiles, verified };
}

/**
 * 单文件恢复的四种结局：
 * - `restored` 已写回并校验一致；`skipped` 目标内容本就与备份一致（幂等，无需写）；
 * - `missing` 备份文件缺失；`failed` 写回/校验失败。
 *
 * 幂等性（2026-11-04 实测驱动）：内容已一致时跳过写入。否则"未曾改动过的文件"也会被
 * 重写一遍 —— 若它恰好位于只读目录，就会在毫无必要的情况下报"回滚失败"，把一次成功的
 * 回滚伪装成失败（用例真实踩到）。
 */
function restoreOneFile(
  backupDir: string,
  projectRoot: string,
  rel: string,
): 'restored' | 'skipped' | 'missing' | 'failed' {
  const src = safeJoin(backupDir, rel);
  if (!fs.existsSync(src)) return 'missing';
  const content = fs.readFileSync(src, 'utf-8');
  const target = safeJoin(projectRoot, rel);
  if (fs.existsSync(target) && fs.readFileSync(target, 'utf-8') === content) return 'skipped';
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    atomicWriteFileSync(target, content);
    return fs.readFileSync(target, 'utf-8') === content ? 'restored' : 'failed';
  } catch {
    return 'failed';
  }
}

/** 删除新建文件；返回是否成功（文件本就不存在也算成功） */
function removeOneFile(abs: string): 'removed' | 'absent' | 'failed' {
  if (!fs.existsSync(abs)) return 'absent';
  try {
    fs.rmSync(abs, { force: true });
    return 'removed';
  } catch {
    return 'failed';
  }
}

/**
 * 回滚一次自动修复（同一进程内使用：列表已在内存里，不必读清单）。
 *
 * 与 {@link restoreFromBackup} 同源语义（含幂等跳过）；任一**实际需要恢复**的文件写回失败
 * 都会抛出 —— 静默吞掉会把"回滚失败"伪装成"回滚成功"，那比不回滚更危险。
 */
export function rollbackFixes(
  projectRoot: string,
  backupDir: string | null,
  backedUpFiles: readonly string[],
  createdFiles: readonly string[],
): void {
  const failures: string[] = [];
  if (backupDir) {
    for (const rel of backedUpFiles) {
      const failure = rollbackOneFile(backupDir, projectRoot, rel);
      if (failure) failures.push(failure);
    }
  }
  for (const abs of createdFiles) {
    if (removeOneFile(abs) === 'failed') failures.push(`${abs}: 删除新建文件失败`);
  }
  if (failures.length > 0) {
    throw new Error(`回滚有 ${failures.length} 处失败：${failures.join('；')}`);
  }
}

/** 回滚单个已备份文件；返回失败说明（null = 已恢复或无需恢复） */
function rollbackOneFile(backupDir: string, projectRoot: string, rel: string): string | null {
  const src = safeJoin(backupDir, rel);
  if (!fs.existsSync(src)) return `${rel}: 备份文件缺失，无法恢复`;
  const backupContent = fs.readFileSync(src, 'utf-8');
  const target = safeJoin(projectRoot, rel);
  // 幂等：内容已与备份一致 = 本来就没被改动（含只读目录情形，不必也无法再写）
  if (fs.existsSync(target) && fs.readFileSync(target, 'utf-8') === backupContent) return null;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    atomicWriteFileSync(target, backupContent);
    return fs.readFileSync(target, 'utf-8') === backupContent
      ? null
      : `${rel}: 回滚后内容与备份不一致`;
  } catch (err) {
    return `${rel}: ${err instanceof Error ? err.message : String(err)}`;
  }
}
