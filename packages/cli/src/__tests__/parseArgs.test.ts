import { describe, it, expect } from 'vitest';

function parseArgs(argv: string[]): {
  command: string;
  dir: string;
  dryRun: boolean;
  sop: boolean;
  verbose: boolean;
  color: boolean;
  help: boolean;
} {
  const opts = {
    command: '',
    dir: process.cwd(),
    dryRun: false,
    sop: false,
    verbose: false,
    color: true,
    help: false,
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
    const opts = parseArgs(['node', 'index.ts', 'pipeline', '--dir', '/my/project', '--sop', '--verbose', '--dry-run']);
    expect(opts.command).toBe('pipeline');
    expect(opts.dir).toBe('/my/project');
    expect(opts.sop).toBe(true);
    expect(opts.verbose).toBe(true);
    expect(opts.dryRun).toBe(true);
  });
});
