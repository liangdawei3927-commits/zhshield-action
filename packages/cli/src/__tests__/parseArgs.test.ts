import { describe, it, expect } from 'vitest';
import { isFailOnValue, FAIL_ON_VALUES } from '@zh/reporter';

function parseArgs(argv: string[]): {
  command: string;
  dir: string;
  dryRun: boolean;
  sop: boolean;
  verbose: boolean;
  color: boolean;
  help: boolean;
  failOn: 'error' | 'warning' | 'info' | 'none';
  explicitFailOn: boolean;
} {
  const opts = {
    command: '',
    dir: '', // 空串哨兵：与 index.ts createDefaultOptions 保持一致，未传 --dir 时由 resolveProjectDir 兜底
    dryRun: false,
    sop: false,
    verbose: false,
    color: true,
    help: false,
    failOn: 'error' as 'error' | 'warning' | 'info' | 'none',
    explicitFailOn: false,
  };
  const args = argv.slice(2);
  if (args.length === 0) {
    opts.help = true;
    return opts;
  }
  opts.command = args[0];
  if (opts.command === 'help') {
    opts.help = true;
  }
  for (let i = 1; i < args.length; i++) {
    switch (args[i]) {
      case '--dir':
        opts.dir = args[++i] || opts.dir;
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--sop':
        opts.sop = true;
        break;
      case '--verbose':
        opts.verbose = true;
        break;
      case '--no-color':
        opts.color = false;
        break;
      case '--fail-on': {
        // 解析边界校验：与 index.ts parseFlags 保持一致，非法值抛错（镜像内不能 process.exit）
        const raw = args[++i];
        if (!isFailOnValue(raw)) {
          throw new Error(
            `非法 --fail-on 值: ${raw ?? '(空)'}，合法值: ${FAIL_ON_VALUES.join(' | ')}`,
          );
        }
        opts.failOn = raw;
        opts.explicitFailOn = true;
        break;
      }
      case 'help':
      case '--help':
        opts.help = true;
        break;
    }
  }
  return opts;
}

describe('CLI argument parsing', () => {
  it('should show help when no args', () => {
    const opts = parseArgs(['node', 'index.ts']);
    expect(opts.help).toBe(true);
  });

  it('should parse guard command', () => {
    const opts = parseArgs(['node', 'index.ts', 'guard']);
    expect(opts.command).toBe('guard');
    expect(opts.help).toBe(false);
  });

  it('should parse --dry-run flag', () => {
    const opts = parseArgs(['node', 'index.ts', 'guard', '--dry-run']);
    expect(opts.dryRun).toBe(true);
  });

  it('should parse --dir option', () => {
    const opts = parseArgs(['node', 'index.ts', 'inspect', '--dir', '/tmp/test']);
    expect(opts.dir).toBe('/tmp/test');
  });

  it('should parse --sop flag', () => {
    const opts = parseArgs(['node', 'index.ts', 'pipeline', '--sop']);
    expect(opts.sop).toBe(true);
  });

  it('should parse --verbose flag', () => {
    const opts = parseArgs(['node', 'index.ts', 'guard', '--verbose']);
    expect(opts.verbose).toBe(true);
  });

  it('should parse --no-color flag', () => {
    const opts = parseArgs(['node', 'index.ts', 'guard', '--no-color']);
    expect(opts.color).toBe(false);
  });

  it('should handle help command', () => {
    const opts = parseArgs(['node', 'index.ts', 'help']);
    expect(opts.help).toBe(true);
  });

  it('should parse pipeline command with all options', () => {
    const opts = parseArgs([
      'node',
      'index.ts',
      'pipeline',
      '--dir',
      '/my/project',
      '--sop',
      '--verbose',
      '--dry-run',
    ]);
    expect(opts.command).toBe('pipeline');
    expect(opts.dir).toBe('/my/project');
    expect(opts.sop).toBe(true);
    expect(opts.verbose).toBe(true);
    expect(opts.dryRun).toBe(true);
  });

  it('should parse --fail-on warning', () => {
    const opts = parseArgs(['node', 'index.ts', 'guard', '--fail-on', 'warning']);
    expect(opts.failOn).toBe('warning');
    expect(opts.explicitFailOn).toBe(true);
  });

  it('should reject invalid --fail-on value critical', () => {
    expect(() => parseArgs(['node', 'index.ts', 'guard', '--fail-on', 'critical'])).toThrow(
      /非法 --fail-on 值: critical/,
    );
  });

  it('should reject --fail-on without argument', () => {
    expect(() => parseArgs(['node', 'index.ts', 'guard', '--fail-on'])).toThrow(
      /非法 --fail-on 值: \(空\)/,
    );
  });

  it('should validate all FAIL_ON_VALUES via isFailOnValue', () => {
    for (const v of FAIL_ON_VALUES) {
      expect(isFailOnValue(v)).toBe(true);
    }
    expect(isFailOnValue('critical')).toBe(false);
    expect(isFailOnValue('nonexistent')).toBe(false);
    expect(isFailOnValue('')).toBe(false);
    expect(isFailOnValue(undefined)).toBe(false);
  });
});
