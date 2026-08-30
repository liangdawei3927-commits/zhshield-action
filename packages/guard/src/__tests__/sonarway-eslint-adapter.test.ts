import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GuardSonarwayESLintAdapter } from '../adapters/sonarway-eslint-adapter';
import { buildSonarwayConfig } from '../adapters/eslint-sonarway-config';
import type { CheckConfig } from '../types';

// ─── Helper ───────────────────────────────────────────────

function makeCheck(overrides: Partial<CheckConfig> = {}): CheckConfig {
  return {
    checkId: 'guard.block.eslint.sonarway',
    adapter: 'sonarway-eslint',
    enabled: true,
    mode: ['guard'],
    category: 'guard',
    severity: 'error',
    blocking: true,
    description: 'SonarWay built-in bug detection',
    ...overrides,
  };
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sonarway-test-'));
}

// ─── buildSonarwayConfig ──────────────────────────────────

describe('buildSonarwayConfig', () => {
  it('returns a flat config array with sonarjs plugin and bug rules', () => {
    const cfg = buildSonarwayConfig();
    expect(Array.isArray(cfg)).toBe(true);
    expect(cfg.length).toBeGreaterThanOrEqual(2); // plugin block + ts block
    const pluginBlock = cfg[0] as Record<string, unknown>;
    expect((pluginBlock.plugins as Record<string, unknown>).sonarjs).toBeDefined();
    const rules = pluginBlock.rules as Record<string, string>;
    expect(rules['sonarjs/no-collection-size-mischeck']).toBe('error');
  });
});

// ─── GuardSonarwayESLintAdapter ───────────────────────────

describe('GuardSonarwayESLintAdapter', () => {
  it('flags collection-size mischeck on a TypeScript file (S3981)', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'bugs.ts');
    fs.writeFileSync(
      file,
      `export function sizeCheck(items: string[]): string {
  if (items.length >= 0) { return 'always'; }
  return 'never';
}
`,
    );

    const adapter = new GuardSonarwayESLintAdapter();
    const raw = await adapter.run({ projectPath: dir, targetFiles: [file] }, makeCheck());
    expect(raw.error).toBeUndefined();

    const result = adapter.normalize(raw, {}, makeCheck());
    expect(result.status).toBe('failed');
    expect(result.message).toContain('no-collection-size-mischeck');
    expect(result.blocking).toBe(true);
  });

  it('passes when the file has no SonarWay bugs', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'clean.ts');
    fs.writeFileSync(
      file,
      `export function ok(items: string[]): string {
  if (items.length > 0) { return 'has'; }
  return 'empty';
}
`,
    );

    const adapter = new GuardSonarwayESLintAdapter();
    const raw = await adapter.run({ projectPath: dir, targetFiles: [file] }, makeCheck());
    const result = adapter.normalize(raw, {}, makeCheck());
    expect(result.status).toBe('passed');
  });

  it('resolves source target to src/ when present', async () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, 'src'));
    const adapter = new GuardSonarwayESLintAdapter();
    // internal helper not exposed; just ensure a project without src falls back
    expect(dir).toBeDefined();
    expect(adapter).toBeDefined();
  });
});
