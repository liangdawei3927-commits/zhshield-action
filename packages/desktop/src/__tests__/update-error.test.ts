import { describe, it, expect } from 'vitest';
import {
  classifyUpdateError,
  describeError,
  UPDATE_ERROR_MESSAGES,
} from '../../electron/update-error';

describe('update-error 错误分类', () => {
  it('签名/完整性校验失败 → UPDATE_SIGNATURE_INVALID，文案不含原始细节', () => {
    const err = new Error(
      'sha512 checksum mismatch, expected abc123, got def456 (file: /var/folders/x/app.zip)',
    );
    const info = classifyUpdateError(err);
    expect(info.code).toBe('UPDATE_SIGNATURE_INVALID');
    expect(info.message).toBe(UPDATE_ERROR_MESSAGES.UPDATE_SIGNATURE_INVALID);
    expect(info.message).not.toMatch(/var\/folders|sha512|abc123/);
  });

  it('网络错误（net:: / DNS / 连接拒绝）→ UPDATE_NETWORK_ERROR', () => {
    expect(classifyUpdateError(new Error('net::ERR_INTERNET_DISCONNECTED')).code).toBe(
      'UPDATE_NETWORK_ERROR',
    );
    expect(classifyUpdateError(new Error('getaddrinfo ENOTFOUND github.com')).code).toBe(
      'UPDATE_NETWORK_ERROR',
    );
    expect(classifyUpdateError(new Error('request to https://x failed, reason: ECONNRESET')).code).toBe(
      'UPDATE_NETWORK_ERROR',
    );
  });

  it('清单缺失/404 → UPDATE_CHECK_FAILED', () => {
    expect(classifyUpdateError(new Error('Cannot find app-update.yml')).code).toBe(
      'UPDATE_CHECK_FAILED',
    );
    expect(classifyUpdateError(new Error('404: Not Found - latest-mac.yml')).code).toBe(
      'UPDATE_CHECK_FAILED',
    );
  });

  it('磁盘/权限失败 → UPDATE_DOWNLOAD_FAILED', () => {
    expect(classifyUpdateError(new Error('ENOSPC: no space left on device')).code).toBe(
      'UPDATE_DOWNLOAD_FAILED',
    );
    expect(classifyUpdateError(new Error('EACCES: permission denied, open /Applications/x')).code).toBe(
      'UPDATE_DOWNLOAD_FAILED',
    );
  });

  it('无法匹配的异常 → 降级为 UPDATE_UNKNOWN（同样安全）', () => {
    expect(classifyUpdateError(new Error('some weird internal detail')).code).toBe(
      'UPDATE_UNKNOWN',
    );
    expect(classifyUpdateError('string error')).toEqual({
      code: 'UPDATE_UNKNOWN',
      message: UPDATE_ERROR_MESSAGES.UPDATE_UNKNOWN,
    });
    expect(classifyUpdateError(null).code).toBe('UPDATE_UNKNOWN');
    expect(classifyUpdateError(undefined).code).toBe('UPDATE_UNKNOWN');
  });

  it('describeError 安全处理各类入参（仅供主进程日志）', () => {
    expect(describeError(new Error('boom'))).toBe('boom');
    expect(describeError('raw string')).toBe('raw string');
    expect(describeError(null)).toBe('null');
    // 不可序列化对象兜底不抛异常
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => describeError(circular)).not.toThrow();
  });
});