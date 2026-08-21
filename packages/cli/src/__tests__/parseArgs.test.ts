import { describe, it, expect } from 'vitest';
import { parseArgs } from '../index';

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

  it('should parse --hook as separate arg', () => {
    const opts = parseArgs(['node', 'index.ts', 'guard', '--hook', 'pre-commit']);
    expect(opts.command).toBe('guard');
    expect(opts.hook).toBe('pre-commit');
  });

  it('should parse --hook=value form', () => {
    const opts = parseArgs(['node', 'index.ts', 'guard', '--hook=pre-push']);
    expect(opts.hook).toBe('pre-push');
  });

  it('should parse --staged flag', () => {
    const opts = parseArgs(['node', 'index.ts', 'guard', '--staged']);
    expect(opts.staged).toBe(true);
  });

  it('should parse hook command with staged and dry-run', () => {
    const opts = parseArgs(['node', 'index.ts', 'guard', '--hook=pre-commit', '--staged', '--dry-run']);
    expect(opts.command).toBe('guard');
    expect(opts.hook).toBe('pre-commit');
    expect(opts.staged).toBe(true);
    expect(opts.dryRun).toBe(true);
  });

  it('should parse --help flag after command', () => {
    const opts = parseArgs(['node', 'index.ts', 'guard', '--help']);
    expect(opts.help).toBe(true);
  });

  it('should ignore unknown flags', () => {
    const opts = parseArgs(['node', 'index.ts', 'guard', '--unknown-flag']);
    expect(opts.command).toBe('guard');
    expect(opts.help).toBe(false);
  });

  it('should keep default dir when --dir has no value', () => {
    const opts = parseArgs(['node', 'index.ts', 'guard', '--dir']);
    expect(opts.dir).toBe(process.cwd());
  });

  it('should parse deps command', () => {
    const opts = parseArgs(['node', 'index.ts', 'deps']);
    expect(opts.command).toBe('deps');
    expect(opts.json).toBe(false);
    expect(opts.sbom).toBeUndefined();
  });

  it('should parse deps --dir option', () => {
    const opts = parseArgs(['node', 'index.ts', 'deps', '--dir', '/tmp/x']);
    expect(opts.dir).toBe('/tmp/x');
  });

  it('should parse deps --sbom option', () => {
    const opts = parseArgs(['node', 'index.ts', 'deps', '--sbom', 'out.json']);
    expect(opts.sbom).toBe('out.json');
  });

  it('should parse deps --json flag', () => {
    const opts = parseArgs(['node', 'index.ts', 'deps', '--json']);
    expect(opts.json).toBe(true);
  });
});
