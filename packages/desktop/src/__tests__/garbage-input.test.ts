import { describe, it, expect } from 'vitest';
import {
  validateGarbageCleanItems,
  isValidBatchId,
} from '../../electron/garbage-input';

/**
 * 垃圾清理 IPC 边界校验回归：
 * 业务意义 —— 渲染进程同源 XSS 可调用 engine:garbageClean / engine:garbageRestore
 * 提交任意 payload；ipc-security 只校验来源不校验内容，故内容校验必须在此层兜底。
 * 合法扫描结果必须放行（不误伤正常清理），非法 payload 必须整批拒绝。
 */
describe('validateGarbageCleanItems', () => {
  const validItem = {
    id: 'item-1',
    path: 'node_modules/.cache/foo',
    size: 1024,
    type: 'build-artifact',
  };

  it('合法批次通过，并保留可选 reason', () => {
    const result = validateGarbageCleanItems([
      validItem,
      { ...validItem, id: 'item-2', reason: 'unused' },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.items).toHaveLength(2);
      expect(result.items[0]).toEqual(validItem);
      expect(result.items[1].reason).toBe('unused');
    }
  });

  it('空数组通过（无条目可清理）', () => {
    const result = validateGarbageCleanItems([]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.items).toEqual([]);
  });

  it('非数组整批拒绝', () => {
    for (const bad of [null, undefined, 'x', 42, {}, { items: [] }]) {
      const result = validateGarbageCleanItems(bad);
      expect(result.ok).toBe(false);
    }
  });

  it('元素非普通对象拒绝', () => {
    for (const bad of [null, 'x', 42, [], [validItem]]) {
      const result = validateGarbageCleanItems([bad]);
      expect(result.ok).toBe(false);
    }
  });

  it('缺失或空 id 拒绝', () => {
    expect(validateGarbageCleanItems([{ ...validItem, id: undefined }]).ok).toBe(false);
    expect(validateGarbageCleanItems([{ ...validItem, id: '' }]).ok).toBe(false);
    expect(validateGarbageCleanItems([{ ...validItem, id: 123 }]).ok).toBe(false);
  });

  it('非有限或负数 size 拒绝', () => {
    expect(validateGarbageCleanItems([{ ...validItem, size: Number.NaN }]).ok).toBe(false);
    expect(validateGarbageCleanItems([{ ...validItem, size: Number.POSITIVE_INFINITY }]).ok).toBe(
      false,
    );
    expect(validateGarbageCleanItems([{ ...validItem, size: -1 }]).ok).toBe(false);
    expect(validateGarbageCleanItems([{ ...validItem, size: '10' }]).ok).toBe(false);
  });

  it('path 含 .. 段拒绝', () => {
    expect(validateGarbageCleanItems([{ ...validItem, path: '../etc/passwd' }]).ok).toBe(false);
    expect(validateGarbageCleanItems([{ ...validItem, path: 'a/../../b' }]).ok).toBe(false);
    expect(validateGarbageCleanItems([{ ...validItem, path: 'a\\..\\b' }]).ok).toBe(false);
  });

  it('绝对路径拒绝', () => {
    expect(validateGarbageCleanItems([{ ...validItem, path: '/etc/passwd' }]).ok).toBe(false);
    expect(validateGarbageCleanItems([{ ...validItem, path: 'C:\\Windows' }]).ok).toBe(false);
    expect(validateGarbageCleanItems([{ ...validItem, path: '\\\\server\\share' }]).ok).toBe(false);
  });

  it('path 含 NUL 字节拒绝', () => {
    expect(validateGarbageCleanItems([{ ...validItem, path: 'a\0b' }]).ok).toBe(false);
  });

  it('path 缺失或空拒绝', () => {
    expect(validateGarbageCleanItems([{ ...validItem, path: undefined }]).ok).toBe(false);
    expect(validateGarbageCleanItems([{ ...validItem, path: '' }]).ok).toBe(false);
  });

  it('type 非字符串拒绝', () => {
    expect(validateGarbageCleanItems([{ ...validItem, type: 1 }]).ok).toBe(false);
    expect(validateGarbageCleanItems([{ ...validItem, type: undefined }]).ok).toBe(false);
  });

  it('首个非法元素即整批拒绝（后续合法元素不救场）', () => {
    const result = validateGarbageCleanItems([{ ...validItem, id: '' }, validItem]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('index 0');
  });
});

describe('isValidBatchId', () => {
  it('规范 UUID 为真（大小写不敏感）', () => {
    expect(isValidBatchId('123e4567-e89b-42d3-a456-426614174000')).toBe(true);
    expect(isValidBatchId('123E4567-E89B-42D3-A456-426614174000')).toBe(true);
  });

  it('非 UUID 一律为假', () => {
    for (const bad of ['..', 'a/b', '', 'abc', 'not-a-uuid', 123, null, undefined, {}]) {
      expect(isValidBatchId(bad)).toBe(false);
    }
  });
});
