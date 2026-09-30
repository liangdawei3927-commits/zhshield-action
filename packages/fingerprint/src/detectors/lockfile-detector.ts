// lockfile-detector（权重 0.3）：解析各生态 lockfile 的直接依赖清单（M0 仅存清单供展示，
// 包管理器归属由 manifest-detector 的 manifest:package-manager 信号负责）。

import type { Detector } from '../detector';
import type { Signal, SignalKind } from '../types';
import { findMarkerProjectRoot, listRootFiles } from '../fs-utils';
import { makeSignal } from './types';
import { parseLockfile } from './lockfile-parsers';

const KIND: SignalKind = 'lockfile';
const LOCKFILE_NAMES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'go.sum',
  'Cargo.lock',
  'poetry.lock',
  'uv.lock',
  'pom.xml',
  'Pipfile.lock',
]);

export class LockfileDetector implements Detector {
  readonly id = 'lockfile-detector';
  readonly signalKinds = [KIND] as const;
  readonly weight = 0.3;

  async detect(projectPath: string): Promise<Signal[]> {
    const root = findMarkerProjectRoot(projectPath, (name) => LOCKFILE_NAMES.has(name));
    const signals: Signal[] = [];
    for (const name of listRootFiles(root)) {
      const parsed = parseLockfile(root, name, name);
      if (parsed === null) continue;
      signals.push(
        makeSignal({
          kind: KIND,
          ruleId: parsed.ruleId,
          file: name,
          weight: this.weight,
          payload: {
            packageManager: parsed.packageManager,
            direct: parsed.direct,
            packageCount: parsed.direct.length,
          },
        }),
      );
    }
    return signals.sort((a, b) =>
      a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : a.file < b.file ? -1 : 1,
    );
  }
}
