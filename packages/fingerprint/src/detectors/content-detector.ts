// content-detector（权重 0.4）：内容启发式——shebang + import 头部。单信号置信度上限 0.55（融合在 Profiler 层）。

import type { Detector } from '../detector';
import type { Signal, SignalKind, LanguageId } from '../types';
import { walkFiles, readText } from '../fs-utils';
import { makeSignal } from './types';

const KIND: SignalKind = 'content';

const SHEBANG_SAMPLES: ReadonlySet<string> = new Set(['py', 'sh', 'rb', 'js', 'mjs', 'cjs']);
const MAX_SAMPLE_FILES = 200;

function shebangLanguage(interpreter: string): LanguageId | null {
  const base = interpreter.split('/').pop()?.toLowerCase() ?? '';
  if (base.startsWith('python')) return 'python';
  if (base === 'node' || base === 'nodejs') return 'javascript';
  if (base === 'bash' || base === 'sh' || base === 'zsh') return 'shell';
  if (base === 'ruby') return 'ruby';
  if (base === 'php') return 'php';
  return null;
}

/** .py 文件头部 import 启发式（仅限 .py，避免与 ESM import 混淆）。 */
function pythonImportLanguage(head: string): LanguageId | null {
  if (/^\s*(?:from|import)\s+[a-z_][a-z0-9_]*/m.test(head)) return 'python';
  return null;
}

/**
 * shebang（#!/usr/bin/env python3 等）+ import 头部启发式。
 * 采样上限 MAX_SAMPLE_FILES 防止大仓库全量读盘。
 */
export class ContentDetector implements Detector {
  readonly id = 'content-detector';
  readonly signalKinds = [KIND] as const;
  readonly weight = 0.4;

  async detect(projectPath: string): Promise<Signal[]> {
    const signals: Signal[] = [];
    let sampled = 0;
    for (const rel of walkFiles(projectPath)) {
      if (sampled >= MAX_SAMPLE_FILES) break;
      const dot = rel.lastIndexOf('.');
      const ext = dot === -1 ? '' : rel.slice(dot + 1);
      if (!SHEBANG_SAMPLES.has(ext)) continue;
      let head: string;
      try {
        head = readText(projectPath, rel).slice(0, 4096);
      } catch {
        continue; // 文件读取失败跳过（权限/并发删除）
      }
      sampled += 1;
      const shebang = head.match(/^#!\s*(?:.*?\/env\s+)?([^\s]+)/m);
      if (shebang !== null) {
        const lang = shebangLanguage(shebang[1]);
        if (lang !== null) {
          signals.push(makeSignal(KIND, 'content:shebang', rel, this.weight, { language: lang, interpreter: shebang[1] }));
        }
      }
      if (ext === 'py') {
        const lang = pythonImportLanguage(head);
        if (lang !== null) signals.push(makeSignal(KIND, 'content:import', rel, this.weight, { language: lang }));
      }
    }
    return signals.sort((a, b) => (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : a.file < b.file ? -1 : 1));
  }
}
