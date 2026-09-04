import { describe, it, expect } from 'vitest';
import { isToolInScope, filterToolsByProfile } from '../tool-scope';
import type { ScopeProfile } from '../tool-scope';

describe('isToolInScope', () => {
  it('security 域工具恒在 scope 内（不随画像变化）', () => {
    for (const tool of ['semgrep', 'trivy', 'grype', 'gitleaks', 'npm-audit']) {
      expect(isToolInScope(tool, { language: 'go', features: [] })).toBe(true);
    }
  });

  it('未在映射表内的工具默认启用（缺省全量兼容）', () => {
    expect(isToolInScope('prettier', { language: 'go', features: [] })).toBe(true);
    expect(isToolInScope('sonarway', undefined)).toBe(true);
  });

  it('无画像时全部工具启用', () => {
    expect(isToolInScope('eslint', undefined)).toBe(true);
    expect(isToolInScope('dep-cruiser', undefined)).toBe(true);
    expect(isToolInScope('ts-prune', undefined)).toBe(true);
    expect(isToolInScope('tsc', undefined)).toBe(true);
  });

  it('eslint/dep-cruiser 仅对 TS/JS 启用', () => {
    const ts: ScopeProfile = { language: 'typescript', features: [] };
    expect(isToolInScope('eslint', ts)).toBe(true);
    expect(isToolInScope('dep-cruiser', ts)).toBe(true);
    expect(isToolInScope('eslint', { language: 'go', features: [] })).toBe(false);
    expect(isToolInScope('dep-cruiser', { language: 'rust', features: [] })).toBe(false);
  });

  it('ts-prune/tsc 仅对 TS 启用', () => {
    expect(isToolInScope('ts-prune', { language: 'typescript', features: [] })).toBe(true);
    expect(isToolInScope('tsc', { language: 'typescript', features: [] })).toBe(true);
    expect(isToolInScope('ts-prune', { language: 'javascript', features: [] })).toBe(false);
    expect(isToolInScope('tsc', { language: 'python', features: [] })).toBe(false);
  });
});

describe('filterToolsByProfile', () => {
  const tools = [
    { id: 'semgrep' },
    { id: 'eslint' },
    { id: 'dep-cruiser' },
    { id: 'tsc' },
    { id: 'trivy' },
  ];

  it('无画像时原样返回全部工具', () => {
    const out = filterToolsByProfile(tools, undefined);
    expect(out).toHaveLength(5);
  });

  it('TS 画像裁剪非 TS 工具', () => {
    const out = filterToolsByProfile(tools, { language: 'typescript', features: [] });
    const ids = out.map((t) => t.id).sort();
    expect(ids).toEqual(['dep-cruiser', 'eslint', 'semgrep', 'trivy', 'tsc']);
  });

  it('go 画像仅保留 security 工具', () => {
    const out = filterToolsByProfile(tools, { language: 'go', features: [] });
    const ids = out.map((t) => t.id).sort();
    expect(ids).toEqual(['semgrep', 'trivy']);
  });

  it('不修改原数组', () => {
    const original = [...tools];
    filterToolsByProfile(tools, { language: 'go', features: [] });
    expect(tools).toEqual(original);
  });
});
