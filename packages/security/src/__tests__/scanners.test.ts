import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MalwareScanner, mapSemgrepIssuesToMalware } from '../malware-scanner';
import { GarbageScanner, mapDepcheckIssuesToGarbage } from '../garbage-scanner';
import type { Issue } from '@zh/shared';

function makeIssue(partial: Partial<Issue> & Pick<Issue, 'ruleId' | 'message' | 'file'>): Issue {
  return {
    id: 'i1',
    severity: 'error',
    category: 'security',
    autoFixable: false,
    source: 'security',
    fingerprint: 'fp',
    ...partial,
  };
}

describe('MalwareScanner', () => {
  it('detects base64 eval backdoor pattern', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zh-malware-'));
    fs.writeFileSync(path.join(dir, 'evil.js'), 'eval(atob("YWxlcnQoMSk="));\n');
    const items = await new MalwareScanner().scan(dir);
    expect(items.some((i) => i.type === 'backdoor')).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('maps semgrep issues to malware items', () => {
    const mapped = mapSemgrepIssuesToMalware([
      makeIssue({ ruleId: 'zh-backdoor-eval-atob', message: 'backdoor eval', file: 'a.ts' }),
    ]);
    expect(mapped).toHaveLength(1);
    expect(mapped[0].type).toBe('suspicious-behavior');
  });
});

describe('GarbageScanner', () => {
  it('flags .log and .DS_Store files', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zh-garbage-'));
    fs.writeFileSync(path.join(dir, 'debug.log'), 'x');
    fs.writeFileSync(path.join(dir, '.DS_Store'), '');
    const items = await new GarbageScanner().scan(dir);
    expect(items.some((i) => i.path.endsWith('debug.log'))).toBe(true);
    expect(items.some((i) => i.path.endsWith('.DS_Store'))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('maps depcheck unused deps', () => {
    const mapped = mapDepcheckIssuesToGarbage([
      makeIssue({
        ruleId: 'depcheck/unused-dep',
        message: 'Unused dependency: lodash',
        file: 'package.json',
        category: 'dependency',
        severity: 'warning',
      }),
    ]);
    expect(mapped).toHaveLength(1);
    expect(mapped[0].type).toBe('unused-dependency');
  });
});
