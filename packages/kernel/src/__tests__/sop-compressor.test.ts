import { describe, it, expect } from 'vitest';
import { SopCompressor, CompressionFormat } from '../sop/cache/sop-compressor';
import type { SopDiff } from '../sop/_meta/sop-types';

describe('SopCompressor', () => {
  const compressor = new SopCompressor();

  // ─── 基础压缩/解压缩往返 ───────────────────────────
  describe('compress / decompress 往返', () => {
    it('gzip 格式应可往返还原原始数据', async () => {
      const original = Buffer.from('hello zhshield-sop', 'utf-8');
      const compressed = await compressor.compress(original, CompressionFormat.Gzip);
      const restored = await compressor.decompress(compressed, CompressionFormat.Gzip);
      expect(restored.equals(original)).toBe(true);
    });

    it('brotli 格式应可往返还原原始数据', async () => {
      const original = Buffer.from('brotli-content-测试', 'utf-8');
      const compressed = await compressor.compress(original, CompressionFormat.Brotli);
      const restored = await compressor.decompress(compressed, CompressionFormat.Brotli);
      expect(restored.equals(original)).toBe(true);
    });

    it('cbor（简化实现）应可往返还原原始数据', async () => {
      const original = Buffer.from('cbor-fallback', 'utf-8');
      const compressed = await compressor.compress(original, CompressionFormat.Cbor);
      const restored = await compressor.decompress(compressed, CompressionFormat.Cbor);
      expect(restored.equals(original)).toBe(true);
    });
  });

  // ─── 压缩率：结构化文本应明显缩小 ───────────────────
  describe('压缩效果', () => {
    it('brotli 对重复结构化文本应产生较高压缩率', async () => {
      const repeated = Buffer.from(JSON.stringify({ rule: 'x'.repeat(2000) }), 'utf-8');
      const compressed = await compressor.compress(repeated, CompressionFormat.Brotli);
      expect(compressed.length).toBeLessThan(repeated.length);
    });

    it('gzip 对重复文本应产生较高压缩率', async () => {
      const repeated = Buffer.from('A'.repeat(5000), 'utf-8');
      const compressed = await compressor.compress(repeated, CompressionFormat.Gzip);
      expect(compressed.length).toBeLessThan(repeated.length / 2);
    });
  });

  // ─── Diff 压缩 ────────────────────────────────────
  describe('compressDiff / decompressDiff', () => {
    const makeDiff = (size: number): SopDiff => ({
      version: '1.0.0',
      fromVersion: '0.9.0',
      compatibility: '1.0.0',
      added: Array.from({ length: size }, (_, i) => ({
        id: `rule-${i}`,
        name: `rule-${i}`,
        domain: 'guard' as const,
        action: 'scan' as const,
        source: 'official' as const,
        description: 'desc',
        status: 'active' as const,
        executionMode: 'sync' as const,
        severity: 'medium' as const,
        applicableEngines: ['guard'],
        content: {},
        tags: [],
        falsePositiveCount: 0,
        truePositiveCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
      removed: [],
      modified: [],
      unchanged: [],
      metadata: { totalRules: size, diffSize: 0, hash: 'h' },
    });

    it('小 diff（<1MB）应使用 gzip 并可往返还原', async () => {
      const diff = makeDiff(10);
      const compressed = await compressor.compressDiff(diff);
      const restored = await compressor.decompressDiff(compressed);
      expect(restored.version).toBe(diff.version);
      expect(restored.added.length).toBe(10);
      expect(restored.added[0].id).toBe('rule-0');
    });

    it('大 diff（>1MB）应使用 brotli 并可往返还原', async () => {
      // 构造 >1MB 的 JSON
      const diff = makeDiff(5000);
      const jsonSize = Buffer.byteLength(JSON.stringify(diff), 'utf-8');
      expect(jsonSize).toBeGreaterThan(1_000_000);

      const compressed = await compressor.compressDiff(diff);
      const restored = await compressor.decompressDiff(compressed);
      expect(restored.added.length).toBe(5000);
      expect(restored.metadata.totalRules).toBe(5000);
    });

    it('decompressDiff 对未知格式应回退返回原始内容', async () => {
      // 非 gzip/brotli 数据 → decompressAny 回退为 Buffer.from(data)
      const diff = makeDiff(1);
      const rawJson = Buffer.from(JSON.stringify(diff), 'utf-8');
      const restored = await compressor.decompressDiff(rawJson);
      expect(restored.version).toBe(diff.version);
    });
  });

  // ─── CBOR 简化实现 ────────────────────────────────
  describe('jsonToCbor / cborToJson', () => {
    it('应可往返还原 JSON 对象', () => {
      const data = { a: 1, b: 'text', nested: { c: [1, 2, 3] } };
      const buffer = compressor.jsonToCbor(data);
      const restored = compressor.cborToJson<typeof data>(buffer);
      expect(restored).toEqual(data);
    });

    it('应可往返还原数组', () => {
      const data = [1, 'two', { three: 3 }];
      const buffer = compressor.jsonToCbor(data);
      const restored = compressor.cborToJson<typeof data>(buffer);
      expect(restored).toEqual(data);
    });
  });

  // ─── 智能策略选择 ─────────────────────────────────
  describe('selectStrategy', () => {
    it('全量同步应选择 brotli（最高压缩率）', () => {
      expect(compressor.selectStrategy(100_000, true)).toBe(CompressionFormat.Brotli);
    });

    it('全量同步无论数据大小都选 brotli', () => {
      expect(compressor.selectStrategy(100, true)).toBe(CompressionFormat.Brotli);
      expect(compressor.selectStrategy(10_000_000, true)).toBe(CompressionFormat.Brotli);
    });

    it('增量同步 + 极小数据（<10KB）应选 cbor', () => {
      expect(compressor.selectStrategy(5_000, false)).toBe(CompressionFormat.Cbor);
    });

    it('增量同步 + 较大数据（>=10KB）应选 gzip', () => {
      expect(compressor.selectStrategy(10_000, false)).toBe(CompressionFormat.Gzip);
      expect(compressor.selectStrategy(500_000, false)).toBe(CompressionFormat.Gzip);
    });

    it('边界值 10000 字节应选 gzip（>= 阈值）', () => {
      expect(compressor.selectStrategy(10_000, false)).toBe(CompressionFormat.Gzip);
    });
  });
});
