// ContentDetector 单测：shebang + import 头部启发式。

import { describe, expect, it } from 'vitest';
import type { Signal } from '../types';
import { ContentDetector } from '../detectors/content-detector';
import { isRecord } from '../fs-utils';
import { makeTempProject, cleanupTempProject } from './helpers';

const detector = new ContentDetector();

function shebangSignal(signals: readonly Signal[], file: string): Signal | undefined {
  return signals.find((s) => s.ruleId === 'content:shebang' && s.file === file);
}

function languageOf(signal: Signal): string {
  const payload = signal.payload;
  if (!isRecord(payload) || typeof payload.language !== 'string') {
    throw new Error(`invalid payload for ${signal.ruleId}`);
  }
  return payload.language;
}

describe('ContentDetector', () => {
  it('GIVEN #!/usr/bin/env python3 脚本 WHEN detect THEN 产出 content:shebang python 信号', async () => {
    const root = makeTempProject({
      'tools/run.py': '#!/usr/bin/env python3\nprint("hi")\n',
    });
    try {
      const signals = await detector.detect(root);

      const signal = shebangSignal(signals, 'tools/run.py');
      expect(signal).toBeDefined();
      if (signal !== undefined) {
        expect(languageOf(signal)).toBe('python');
        expect(signal.kind).toBe('content');
        expect(signal.weight).toBe(0.4);
      }
    } finally {
      cleanupTempProject(root);
    }
  });

  it('GIVEN #!/usr/bin/env node 脚本 WHEN detect THEN 产出 javascript 信号', async () => {
    const root = makeTempProject({
      'bin/cli.js': '#!/usr/bin/env node\nconsole.log(1)\n',
    });
    try {
      const signals = await detector.detect(root);

      const signal = shebangSignal(signals, 'bin/cli.js');
      expect(signal).toBeDefined();
      if (signal !== undefined) {
        expect(languageOf(signal)).toBe('javascript');
      }
    } finally {
      cleanupTempProject(root);
    }
  });

  it('GIVEN .py 文件头部 import os（无 shebang）WHEN detect THEN 产出 content:import python 信号', async () => {
    const root = makeTempProject({
      'app/main.py': 'import os\nimport sys\n\nprint(os.getcwd())\n',
    });
    try {
      const signals = await detector.detect(root);

      const signal = signals.find((s) => s.ruleId === 'content:import' && s.file === 'app/main.py');
      expect(signal).toBeDefined();
      if (signal !== undefined) {
        expect(languageOf(signal)).toBe('python');
      }
    } finally {
      cleanupTempProject(root);
    }
  });

  it('GIVEN 无 shebang/import 的源码与文档 WHEN detect THEN 不产出 content 信号', async () => {
    const root = makeTempProject({
      'index.ts': 'export const a = 1;\n',
      'notes.txt': 'plain text\n',
    });
    try {
      const signals = await detector.detect(root);
      expect(signals).toEqual([]);
    } finally {
      cleanupTempProject(root);
    }
  });
});
