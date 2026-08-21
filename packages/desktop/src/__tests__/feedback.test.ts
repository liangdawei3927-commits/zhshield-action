import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  // ipc-context.ts 模块加载时调用 app.getPath('userData')，mock 缺 app 会导致整个套件加载失败
  app: { getPath: vi.fn(() => '/tmp/zh-codeshield-test') },
}));

import {
  appendFalsePositive,
  falsePositivesPath,
  listFalsePositives,
  type FalsePositiveFeedbackItem,
} from '../../electron/ipc/feedback';

let tmpDir: string;

function makeItem(overrides: Partial<FalsePositiveFeedbackItem> = {}): FalsePositiveFeedbackItem {
  return {
    source: 'guard',
    ruleId: 'eslint-error',
    title: 'ESLint 错误',
    message: 'no-unused-vars',
    severity: 'high',
    file: 'src/main.ts',
    line: 42,
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('appendFalsePositive 误报反馈落库', () => {
  it('追加到 <project>/.zhshield/false-positives.jsonl 并生成 id/timestamp', () => {
    const absPath = appendFalsePositive(tmpDir, makeItem());

    expect(absPath).toBe(falsePositivesPath(tmpDir));
    expect(fs.existsSync(absPath)).toBe(true);

    const lines = fs.readFileSync(absPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]) as Record<string, string>;
    expect(record.source).toBe('guard');
    expect(record.ruleId).toBe('eslint-error');
    expect(record.message).toBe('no-unused-vars');
    expect(record.file).toBe('src/main.ts');
    expect(record.line).toBe(42);
    expect(record.id).toBeTruthy();
    expect(record.timestamp).toBeTruthy();
  });

  it('多次追加按行累积', () => {
    appendFalsePositive(tmpDir, makeItem({ ruleId: 'a' }));
    appendFalsePositive(tmpDir, makeItem({ source: 'sentinel', ruleId: 'b', message: 'timeout' }));

    const lines = fs.readFileSync(falsePositivesPath(tmpDir), 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1])).toMatchObject({ source: 'sentinel', ruleId: 'b' });
  });
});

describe('listFalsePositives 误报反馈读取', () => {
  it('文件不存在返回空数组', () => {
    expect(listFalsePositives(tmpDir)).toEqual([]);
    expect(listFalsePositives(tmpDir, 'guard')).toEqual([]);
  });

  it('返回全部记录，最近在前', () => {
    appendFalsePositive(tmpDir, makeItem({ source: 'sentinel', ruleId: 's1', message: 'a' }));
    appendFalsePositive(tmpDir, makeItem({ source: 'guard', ruleId: 'g1', message: 'b' }));

    const records = listFalsePositives(tmpDir);
    expect(records).toHaveLength(2);
    expect(records[0].ruleId).toBe('g1');
    expect(records[1].ruleId).toBe('s1');
  });

  it('按 source 过滤', () => {
    appendFalsePositive(tmpDir, makeItem({ source: 'sentinel', ruleId: 's1', message: 'a' }));
    appendFalsePositive(tmpDir, makeItem({ source: 'guard', ruleId: 'g1', message: 'b' }));

    expect(listFalsePositives(tmpDir, 'guard').map((r) => r.ruleId)).toEqual(['g1']);
    expect(listFalsePositives(tmpDir, 'sentinel').map((r) => r.ruleId)).toEqual(['s1']);
  });

  it('损坏行静默跳过', () => {
    appendFalsePositive(tmpDir, makeItem({ ruleId: 'g1', message: 'ok' }));
    fs.appendFileSync(falsePositivesPath(tmpDir), 'not-json\n', 'utf-8');

    const records = listFalsePositives(tmpDir);
    expect(records).toHaveLength(1);
    expect(records[0].ruleId).toBe('g1');
  });
});
