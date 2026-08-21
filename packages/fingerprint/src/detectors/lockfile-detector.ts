// lockfile-detector（权重 0.3）：解析各生态 lockfile 的直接依赖清单（M0 仅存清单供展示，
// 包管理器归属由 manifest-detector 的 manifest:package-manager 信号负责）。

import type { Detector } from '../detector';
import type { Signal, SignalKind } from '../types';
import { listRootFiles } from '../fs-utils';
import { makeSignal } from './types';
import { parseLockfile } from './lockfile-parsers';
import * as fs from 'node:fs';
import * as path from 'node:path';

const KIND: SignalKind = 'lockfile';
const LOCKFILE_NAMES = new Set(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'go.sum', 'Cargo.lock', 'poetry.lock', 'uv.lock', 'pom.xml', 'Pipfile.lock']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'vendor', '.venv', 'venv', '.opencode']);

function findProjectRoot(projectPath: string): string {
  for (const name of listRootFiles(projectPath)) {
    if (LOCKFILE_NAMES.has(name)) return projectPath;
  }
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(projectPath, { withFileTypes: true });
  } catch {
    return projectPath;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || SKIP_DIRS.has(entry.name)) continue;
    const sub = path.join(projectPath, entry.name);
    for (const name of listRootFiles(sub)) {
      if (LOCKFILE_NAMES.has(name)) return sub;
    }
  }
  return projectPath;
}

export class LockfileDetector implements Detector {
  readonly id = 'lockfile-detector';
  readonly signalKinds = [KIND] as const;
  readonly weight = 0.3;

  async detect(projectPath: string): Promise<Signal[]> {
    const root = findProjectRoot(projectPath);
    const signals: Signal[] = [];
    for (const name of listRootFiles(root)) {
      const parsed = parseLockfile(root, name, name);
      if (parsed === null) continue;
      signals.push(
        makeSignal(KIND, parsed.ruleId, name, this.weight, {
          packageManager: parsed.packageManager,
          direct: parsed.direct,
          packageCount: parsed.direct.length,
        }),
      );
    }
    return signals.sort((a, b) => (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : a.file < b.file ? -1 : 1));
  }
}
