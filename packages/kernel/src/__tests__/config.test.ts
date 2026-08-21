import { describe, it, expect } from 'vitest';
import { ConfigManager } from '../config';

describe('ConfigManager', () => {
  it('should read from env', () => {
    process.env['TEST_KEY'] = 'hello';
    const config = new ConfigManager();
    expect(config.get('TEST_KEY')).toBe('hello');
    delete process.env['TEST_KEY'];
  });

  it('should return default value', () => {
    const config = new ConfigManager();
    expect(config.get('NONEXISTENT', 'fallback')).toBe('fallback');
  });

  it('should cast numbers', () => {
    process.env['PORT'] = '3000';
    const config = new ConfigManager();
    expect(config.get('PORT')).toBe(3000);
    delete process.env['PORT'];
  });

  it('should cast booleans', () => {
    process.env['FLAG'] = 'true';
    const config = new ConfigManager();
    expect(config.get('FLAG')).toBe(true);
    delete process.env['FLAG'];
  });

  it('should throw on missing required', () => {
    const config = new ConfigManager();
    expect(() => config.getOrThrow('MISSING')).toThrow('missing');
  });
});
