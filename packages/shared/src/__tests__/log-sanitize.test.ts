import { describe, it, expect } from 'vitest';
import { sanitizeLogField, MAX_LOG_FIELD_LENGTH } from '../log-sanitize';

describe('sanitizeLogField（日志注入防护）', () => {
  it('剥离 \\n 与 \\r，防止伪造日志行', () => {
    expect(sanitizeLogField('evil\n[FAKE] injected line')).toBe('evil [FAKE] injected line');
    expect(sanitizeLogField('a\rb')).toBe('a b');
    expect(sanitizeLogField('a\r\nb')).toBe('a  b');
  });

  it('非字符串输入转为字符串', () => {
    expect(sanitizeLogField(42)).toBe('42');
    expect(sanitizeLogField(null)).toBe('null');
    expect(sanitizeLogField(undefined)).toBe('undefined');
    expect(sanitizeLogField({ a: 1 })).toBe('[object Object]');
  });

  it('超长字段被截断到 MAX_LOG_FIELD_LENGTH', () => {
    const long = 'x'.repeat(MAX_LOG_FIELD_LENGTH + 100);
    expect(sanitizeLogField(long).length).toBe(MAX_LOG_FIELD_LENGTH);
  });
});
