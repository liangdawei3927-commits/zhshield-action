// ext-stat-detector（权重 0.6）：扩展名统计——按语言产出聚合信号，payload.byDir 供 Profiler 按 scope 归并。
// 单信号置信度上限：无 tsconfig 时 ≤0.65（§6.2/§10 单信号约束，具体融合在 Profiler 层）。

import type { Detector } from '../detector';
import type { Signal, SignalKind } from '../types';
import { EXTENSION_LANGUAGES, STAT_LANGUAGES } from '../language-map';
import { walkFiles, relDirname } from '../fs-utils';
import { makeSignal } from './types';

const KIND: SignalKind = 'ext-stat';

export class ExtStatDetector implements Detector {
  readonly id = 'ext-stat-detector';
  readonly signalKinds = [KIND] as const;
  readonly weight = 0.6;

  async detect(projectPath: string): Promise<Signal[]> {
    const byDir = new Map<string, Map<string, number>>(); // dir -> (language -> count)
    let total = 0;
    for (const rel of walkFiles(projectPath)) {
      const dot = rel.lastIndexOf('.');
      if (dot === -1 || dot === rel.length - 1) continue;
      const lang = EXTENSION_LANGUAGES[rel.slice(dot + 1)];
      if (lang === undefined || !STAT_LANGUAGES.includes(lang)) continue;
      const dir = relDirname(rel);
      let perDir = byDir.get(dir);
      if (perDir === undefined) {
        perDir = new Map();
        byDir.set(dir, perDir);
      }
      perDir.set(lang, (perDir.get(lang) ?? 0) + 1);
      total += 1;
    }
    if (total === 0) return [];
    const signals: Signal[] = [];
    for (const lang of STAT_LANGUAGES) {
      const dirs: Record<string, number> = {};
      let count = 0;
      for (const [dir, perDir] of byDir) {
        const n = perDir.get(lang);
        if (n === undefined) continue;
        dirs[dir] = n;
        count += n;
      }
      if (count === 0) continue;
      signals.push(makeSignal(KIND, `ext-stat:${lang}`, '.', this.weight, { count, ratio: count / total, byDir: dirs }));
    }
    return signals.sort((a, b) => (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0));
  }
}
