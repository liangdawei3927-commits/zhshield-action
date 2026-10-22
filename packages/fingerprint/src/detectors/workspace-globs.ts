// workspace glob 展开：pnpm-workspace.yaml / package.json workspaces 字段
// → 相对目录列表（单层 * 展开 + 显式目录）。自 manifest-detector 原样抽出，无逻辑改动。

import * as fs from 'node:fs';
import * as path from 'node:path';
import { safeJoinReal } from '@zh/shared';
import { isRecord, isNoiseDir, readText } from '../fs-utils';

const PNPM_WORKSPACE_RE = /^\s+-\s+['"]?([^'"]+)['"]?\s*$/;

const isNoiseRel = (rel: string): boolean => rel.split('/').some((segment) => isNoiseDir(segment));

/** 解析 pnpm-workspace.yaml 获取 workspace glob patterns */
export function readPnpmWorkspacePatterns(projectRoot: string): string[] {
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
    if (!inPackages) continue;
    const match = line.match(PNPM_WORKSPACE_RE);
    if (match !== null) {
      patterns.push(match[1]);
    } else if (line.trim().length > 0 && !line.startsWith(' ')) {
      break;
    }
  }
  return patterns;
}

/** pushCandidateMatch 的上下文：项目根、glob 剩余段与结果收集容器 */
interface PushCandidateMatchContext {
  projectRoot: string;
  parts: string[];
  globIdx: number;
  baseDir: string;
  dirs: string[];
}

/** baseDir 下单个子目录是否符合 glob 剩余路径（存在且为目录则加入结果） */
function pushCandidateMatch(ctx: PushCandidateMatchContext, entry: fs.Dirent): void {
  const { projectRoot, parts, globIdx, baseDir, dirs } = ctx;
  const rest = parts.slice(globIdx + 1).join('/');
  const candidate =
    rest.length > 0 ? path.join(baseDir, entry.name, rest) : path.join(baseDir, entry.name);
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory()) return;
  const rel = path.relative(projectRoot, candidate);
  if (isNoiseRel(rel)) return;
  dirs.push(rel);
}

function collectGlobMatches(projectRoot: string, pattern: string, dirs: string[]): void {
  const parts = pattern.split('/');
  const globIdx = parts.findIndex((p) => p === '*');
  if (globIdx === -1) return;
  let baseDir: string;
  try {
    baseDir = safeJoinReal(projectRoot, ...parts.slice(0, globIdx));
  } catch {
    return;
  }
  if (!fs.existsSync(baseDir) || !fs.statSync(baseDir).isDirectory()) return;
  try {
    for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
      if (entry.isDirectory() && !isNoiseDir(entry.name)) {
        pushCandidateMatch({ projectRoot, parts, globIdx, baseDir, dirs }, entry);
      }
    }
  } catch {
    // skip unreadable dirs
  }
}

export function expandWorkspaceGlobs(projectRoot: string, patterns: string[]): string[] {
  const dirs: string[] = [];
  for (const pattern of patterns) {
    if (pattern.includes('*')) {
      collectGlobMatches(projectRoot, pattern, dirs);
      continue;
    }
    let absDir: string;
    try {
      absDir = safeJoinReal(projectRoot, pattern);
    } catch {
      continue; // 越界 pattern（含 .. 或绝对路径），跳过
    }
    if (fs.existsSync(absDir) && fs.statSync(absDir).isDirectory() && !isNoiseRel(pattern)) {
      dirs.push(pattern);
    }
  }
  return dirs;
}

/** 解析根 package.json 的 workspaces 字段（npm/yarn 风格）获取 workspace glob patterns。 */
export function readPackageJsonWorkspacePatterns(projectRoot: string): string[] {
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
