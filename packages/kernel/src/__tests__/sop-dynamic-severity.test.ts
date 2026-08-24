import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { SopLoader } from '../sop/_meta/sop-loader';
import { SopRegistry } from '../sop/_meta/sop-registry';

/** 真实 SOP 规则目录（F1-5：全部存量 YAML 必须零错误加载） */
const SOP_RULES_DIR = path.resolve(__dirname, '../sop');

function makeRulesRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sop-dynamic-severity-'));
}

function writeRuleFile(root: string, relPath: string, content: string): void {
  const fullPath = path.join(root, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf-8');
}

async function loadRoot(root: string): Promise<SopRegistry> {
  const registry = new SopRegistry();
  const loader = new SopLoader(registry, { rulesDir: root });
  await loader.loadFromFileSystem();
  return registry;
}

describe('SopLoader — F1 动态严重级配置（accumulationPolicy / blockingThreshold）', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  const tempDirs: string[] = [];

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function trackDir(): string {
    const dir = makeRulesRoot();
    tempDirs.push(dir);
    return dir;
  }

  // ─── buildSimple：accumulate 简写键 + threshold 缺省 ────
  it('buildSimple 解析 accumulate 简写：threshold 缺省补 3，blockingThreshold 生效', async () => {
    const root = trackDir();
    writeRuleFile(
      root,
      'guard/scan/dyn-simple.yml',
      [
        'name: Dyn Simple',
        'severity: medium',
        'accumulate:',
        '  escalateTo: high',
        'blockingThreshold: high',
      ].join('\n'),
    );

    const registry = await loadRoot(root);
    const rule = registry.get('guard.scan.official.dyn-simple');

    expect(rule).toBeDefined();
    expect(rule?.accumulationPolicy).toEqual({ threshold: 3, escalateTo: 'high' });
    expect(rule?.blockingThreshold).toBe('high');
  });

  // ─── buildSimple：accumulationPolicy 全量键 ─────────────
  it('buildSimple 解析 accumulationPolicy 全量键（threshold/window 显式声明）', async () => {
    const root = trackDir();
    writeRuleFile(
      root,
      'guard/scan/dyn-full.yml',
      [
        'name: Dyn Full',
        'severity: low',
        'accumulationPolicy:',
        '  threshold: 5',
        '  escalateTo: critical',
        '  window: 300',
      ].join('\n'),
    );

    const registry = await loadRoot(root);
    const rule = registry.get('guard.scan.official.dyn-full');

    expect(rule?.accumulationPolicy).toEqual({ threshold: 5, escalateTo: 'critical', window: 300 });
    expect(rule?.blockingThreshold).toBeUndefined();
  });

  // ─── buildWithMeta：metadata + judgment 双 schema 路径 ──
  it('buildWithMeta 同样解析 accumulationPolicy 与 blockingThreshold', async () => {
    const root = trackDir();
    writeRuleFile(
      root,
      'guard/scan/dyn-meta.yml',
      [
        'metadata:',
        '  id: t.meta-dyn',
        '  name: Meta Dyn',
        'judgment:',
        '  priority: medium',
        'accumulationPolicy:',
        '  threshold: 4',
        '  escalateTo: high',
        'blockingThreshold: error',
      ].join('\n'),
    );

    const registry = await loadRoot(root);
    const rule = registry.get('t.meta-dyn');

    expect(rule).toBeDefined();
    expect(rule?.severity).toBe('medium');
    expect(rule?.accumulationPolicy).toEqual({ threshold: 4, escalateTo: 'high' });
    expect(rule?.blockingThreshold).toBe('error');
  });

  // ─── 校验：escalateTo 未严格高于静态 severity → 抛错含规则 id ──
  it('escalateTo 等于静态 severity 时加载失败，错误信息含规则 id', async () => {
    const root = trackDir();
    writeRuleFile(
      root,
      'guard/scan/dyn-equal.yml',
      ['severity: high', 'accumulate:', '  escalateTo: high'].join('\n'),
    );

    await expect(loadRoot(root)).rejects.toThrow(/guard\.scan\.official\.dyn-equal/);
  });

  it('escalateTo 低于静态 severity 时加载失败（meta schema 按 judgment.priority 判定）', async () => {
    const root = trackDir();
    writeRuleFile(
      root,
      'guard/scan/dyn-downgrade.yml',
      [
        'metadata:',
        '  id: t.meta-bad',
        'judgment:',
        '  priority: critical',
        'accumulationPolicy:',
        '  escalateTo: high',
      ].join('\n'),
    );

    await expect(loadRoot(root)).rejects.toThrow(/t\.meta-bad/);
  });

  // ─── 校验：非法 Severity 值 → 抛错含规则 id ─────────────
  it('blockingThreshold 非法值时加载失败，错误信息含规则 id', async () => {
    const root = trackDir();
    writeRuleFile(
      root,
      'guard/scan/dyn-threshold.yml',
      ['severity: low', 'blockingThreshold: fatal'].join('\n'),
    );

    await expect(loadRoot(root)).rejects.toThrow(/dyn-threshold.*blockingThreshold/s);
  });

  it('escalateTo 非法值时加载失败，错误信息含规则 id', async () => {
    const root = trackDir();
    writeRuleFile(
      root,
      'guard/scan/dyn-escalate.yml',
      ['severity: low', 'accumulationPolicy:', '  escalateTo: fatal'].join('\n'),
    );

    await expect(loadRoot(root)).rejects.toThrow(/dyn-escalate.*escalateTo/s);
  });

  it('threshold 为非正整数时加载失败', async () => {
    const root = trackDir();
    writeRuleFile(
      root,
      'guard/scan/dyn-threshold-zero.yml',
      ['severity: low', 'accumulationPolicy:', '  threshold: 0', '  escalateTo: high'].join('\n'),
    );

    await expect(loadRoot(root)).rejects.toThrow(/threshold/);
  });

  // ─── 未知 accumulate 键：warn 告知而非静默忽略 ──────────
  it('未知 accumulate 键触发 console.warn（含规则 id 与键名），已知键照常解析', async () => {
    const root = trackDir();
    writeRuleFile(
      root,
      'guard/scan/dyn-unknown-key.yml',
      [
        'severity: medium',
        'accumulate:',
        '  escalateTo: high',
        '  bogusKey: 1',
      ].join('\n'),
    );

    const registry = await loadRoot(root);
    const rule = registry.get('guard.scan.official.dyn-unknown-key');

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warning = String(warnSpy.mock.calls[0]?.[0]);
    expect(warning).toContain('dyn-unknown-key');
    expect(warning).toContain('bogusKey');
    expect(rule?.accumulationPolicy).toEqual({ threshold: 3, escalateTo: 'high' });
  });

  // ─── 无新字段的规则：行为不变 ───────────────────────────
  it('未声明新字段的规则不携带 accumulationPolicy/blockingThreshold', async () => {
    const root = trackDir();
    writeRuleFile(
      root,
      'guard/scan/plain.yml',
      ['name: Plain', 'severity: medium'].join('\n'),
    );

    const registry = await loadRoot(root);
    const rule = registry.get('guard.scan.official.plain');

    expect(rule?.accumulationPolicy).toBeUndefined();
    expect(rule?.blockingThreshold).toBeUndefined();
  });

  // ─── severity: error 一等合法（两套 builder 往返）───────
  it("severity: 'error' 经 buildSimple 往返保留", async () => {
    const root = trackDir();
    writeRuleFile(root, 'guard/block/ts-error.yml', ['severity: error'].join('\n'));

    const registry = await loadRoot(root);

    expect(registry.get('guard.block.official.ts-error')?.severity).toBe('error');
  });

  it("judgment.priority: 'error' 经 buildWithMeta 映射为 severity 'error'", async () => {
    const root = trackDir();
    writeRuleFile(
      root,
      'guard/block/meta-error.yml',
      ['metadata:', '  id: t.meta-error', 'judgment:', '  priority: error'].join('\n'),
    );

    const registry = await loadRoot(root);

    expect(registry.get('t.meta-error')?.severity).toBe('error');
  });

  // ─── F1-5：全部存量 YAML 零错误加载 + error 档抽查 ─────
  it('真实仓库全部 SOP YAML 加载零错误，存量 severity:error 文件成为一等合法值', async () => {
    const registry = new SopRegistry();
    const loader = new SopLoader(registry, { rulesDir: SOP_RULES_DIR });
    const loaded = await loader.loadFromFileSystem();

    expect(errorSpy).not.toHaveBeenCalled();
    expect(loaded).toBeGreaterThan(0);
    expect(registry.get('guard.block.official.typescript-error')?.severity).toBe('error');
    expect(registry.get('inspect.scan.external.dependency-audit')?.severity).toBe('error');
  });
});
