// config-detector（权重 0.8）：配置文件 → 语言/框架/环境信号。

import type { Detector } from '../detector';
import type { Signal, SignalKind } from '../types';
import { CONFIG_RULES } from '../language-map';
import { walkFiles } from '../fs-utils';
import { makeSignal } from './types';

const KIND: SignalKind = 'config';

const WORKSPACE_FILES: ReadonlySet<string> = new Set([
  'pnpm-workspace.yaml',
  'pnpm-workspace.yml',
  'turbo.json',
  'lerna.json',
  'nx.json',
  'rush.json',
]);

/**
 * tsconfig.json → TS（决定性 0.95）；vue.config.js → Vue；vite.config.* → Vite；
 * next.config.* / nuxt.config.* / svelte.config.* / angular.json / nest-cli.json 等（§6.2 配置文件规则表）。
 */
export class ConfigDetector implements Detector {
  readonly id = 'config-detector';
  readonly signalKinds = [KIND] as const;
  readonly weight = 0.8;

  async detect(projectPath: string): Promise<Signal[]> {
    const signals: Signal[] = [];
    for (const rel of walkFiles(projectPath)) {
      const name = rel.slice(rel.lastIndexOf('/') + 1);
      if (WORKSPACE_FILES.has(name)) {
        signals.push(makeSignal(KIND, 'config:workspace', rel, this.weight, {}));
      }
      for (const rule of CONFIG_RULES) {
        if (!(rule.match(name) || rule.match(rel))) continue;
        const payload: Record<string, unknown> = { confidence: rule.confidence };
        if (rule.framework !== undefined) payload.framework = rule.framework;
        if (rule.environment !== undefined) payload.environment = rule.environment;
        if (rule.language !== undefined) payload.language = rule.language;
        signals.push(makeSignal(KIND, rule.ruleId, rel, this.weight, payload));
      }
    }
    return signals.sort((a, b) =>
      a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : a.file < b.file ? -1 : 1,
    );
  }
}
