/**
 * 分类页「完整报告」落盘 / 读回。
 *
 * 为什么需要它：各分类页的 `report` 只活在渲染层内存里，退出即丢；磁盘上只有
 * `<project>/.zhshield/diagnostics/domains/*.json` 这种**归一化问题条目**快照，
 * 还原不出依赖（outdated / lockfile / 许可证矩阵）、重构（smells / 可维护性）、
 * 技术债（debtIndex / byModule）、安全（findings / malware）等域特有结构。
 * 于是出现「评分看得到（读磁盘）、详情按钮不出现（读内存）」的错位。
 *
 * 这里按域把**完整报告原样**存一份：`<project>/.zhshield/reports/<domain>.json`。
 * 扫描成功后写入，页面打开时读回 —— 详情页渲染的是同一份数据、同一套口径，
 * 不做任何字段再造，也就不存在「通过数 0」这类失真。
 *
 * 边界：读不到 / 损坏 / 旧版本没有该文件 → 返回 null（不猜、不造）。
 * 注意：沙箱禁止 unlink/rename，故直接覆盖写，不做 tmp+rename 原子替换。
 */

import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** 域标识白名单式校验：防 `../` 路径穿越 */
const DOMAIN_RE = /^[a-z][a-z0-9-]{0,31}$/;

function reportsDir(projectPath: string): string {
  return join(projectPath, '.zhshield', 'reports');
}

function reportPath(projectPath: string, domain: string): string | null {
  if (!projectPath || typeof projectPath !== 'string') return null;
  if (typeof domain !== 'string' || !DOMAIN_RE.test(domain)) return null;
  return join(reportsDir(projectPath), `${domain}.json`);
}

/** 写入某域的完整报告（扫描成功后调用）。返回是否落盘成功 */
export async function saveDomainReportHandler(
  _event: Electron.IpcMainInvokeEvent,
  projectPath: string,
  domain: string,
  report: unknown,
): Promise<boolean> {
  const file = reportPath(projectPath, domain);
  if (!file) return false;
  if (report === null || typeof report !== 'object') return false;
  try {
    await mkdir(reportsDir(projectPath), { recursive: true });
    await writeFile(file, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
    return true;
  } catch (err) {
    console.warn('[engine:saveDomainReport] 写入失败:', err);
    return false;
  }
}

/** 文件是否真实存在（用于「是否有落盘结果」判定，不解析内容） */
async function fileExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/** 读回某域最近一次完整报告；不存在 / 损坏返回 null */
export async function getSavedDomainReportHandler(
  _event: Electron.IpcMainInvokeEvent,
  projectPath: string,
  domain: string,
): Promise<unknown | null> {
  const file = reportPath(projectPath, domain);
  if (!file) return null;
  try {
    return JSON.parse(await readFile(file, 'utf-8')) as unknown;
  } catch {
    return null;
  }
}

/**
 * 原样读回某域的**归一化快照**（`.zhshield/diagnostics/domains/<domain>.json`）。
 *
 * 与 `getSavedDomainReport` 的分工：
 * - `getSavedDomainReport` 读「完整报告」（仅新版扫描后才有）；
 * - 本函数读「评分赖以计算的那份快照」，是**旧数据唯一可回看的内容**。
 *
 * 为什么不在渲染层用 `engine:getDomainReport`：那条通道经 `readDomainSnapshot`
 * 做了 `isDiagnosticsReport` 结构校验，垃圾域（`items/checks/skipped` 结构）会被
 * 判为非法而返回 null —— 于是「有分却点不进详情」。这里不做结构校验，
 * 由渲染层按实际字段渲染（有多少显示多少，绝不补造缺失字段）。
 */
export async function getDomainSnapshotRawHandler(
  _event: Electron.IpcMainInvokeEvent,
  projectPath: string,
  domain: string,
): Promise<unknown | null> {
  if (!projectPath || typeof projectPath !== 'string') return null;
  if (typeof domain !== 'string' || !DOMAIN_RE.test(domain)) return null;
  const file = join(projectPath, '.zhshield', 'diagnostics', 'domains', `${domain}.json`);
  try {
    return JSON.parse(await readFile(file, 'utf-8')) as unknown;
  } catch {
    return null;
  }
}

/**
 * 该域是否已有落盘结果 —— 「详情入口是否可见」的唯一判据。
 *
 * 覆盖两种历史产物，任一存在即为「跑过」：
 * - `.zhshield/reports/<domain>.json`（完整报告，新版扫描后才有）
 * - `.zhshield/diagnostics/domains/<domain>.json`（归一化问题快照，评分即由此计算）
 *
 * 判定只回答「有没有跑过」，不回答「内容是什么」——内容由读回接口负责，
 * 避免把「文件存在」当成「有完整报告」而渲染出空详情。
 */
export async function hasDomainResultHandler(
  _event: Electron.IpcMainInvokeEvent,
  projectPath: string,
  domain: string,
): Promise<boolean> {
  const file = reportPath(projectPath, domain);
  if (!file) return false;
  if (await fileExists(file)) return true;
  return fileExists(join(projectPath, '.zhshield', 'diagnostics', 'domains', `${domain}.json`));
}
