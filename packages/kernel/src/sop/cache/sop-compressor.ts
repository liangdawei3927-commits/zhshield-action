import { promisify } from 'node:util';
import { gzip, gunzip, brotliCompress, brotliDecompress, constants } from 'node:zlib';
import type { SopDiff } from '../_meta/sop-types';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const brotliCompressAsync = promisify(brotliCompress);
const brotliDecompressAsync = promisify(brotliDecompress);

export enum CompressionFormat {
  Gzip = 'gzip',
  Brotli = 'br',
  Cbor = 'cbor',
}

/** 压缩格式 → 压缩函数策略表（替代 compress 中的 switch 分派） */
const COMPRESSORS: Partial<Record<CompressionFormat, (data: Buffer | Uint8Array) => Promise<Buffer>>> = {
  [CompressionFormat.Gzip]: (data) => gzipAsync(data, { level: 6 }),
  [CompressionFormat.Brotli]: (data) => brotliCompressAsync(data, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 4,
      [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
    },
  }),
  [CompressionFormat.Cbor]: (data) => gzipAsync(data, { level: 9 }),
};

/** 压缩格式 → 解压函数策略表（替代 decompress 中的 switch 分派） */
const DECOMPRESSORS: Partial<Record<CompressionFormat, (data: Buffer | Uint8Array) => Promise<Buffer>>> = {
  [CompressionFormat.Gzip]: (data) => gunzipAsync(data),
  [CompressionFormat.Brotli]: (data) => brotliDecompressAsync(data),
  [CompressionFormat.Cbor]: (data) => gunzipAsync(data),
};

/**
 * SopCompressor — 传输压缩工具（文档 9.3 节）
 *
 * 规则数据特点：大量重复 key、结构化 JSON、正则表达式文本为主、单条体积小（100B-5KB）
 *
 * | 方案 | 压缩率 | 速度 | 适用场景 |
 * |------|--------|------|---------|
 * | gzip | 70-80% | 中等 | 增量更新 |
 * | brotli | 80-85% | 较慢 | 首次全量同步 |
 * | 增量 + gzip | 95%+ | 快 | 增量更新 |
 * | CBOR 替代 JSON | 30-50%↓ | 快 | 二进制传输 |
 */
export class SopCompressor {
  // ─── 压缩 ──────────────────────────────────────────────────

  /**
   * 压缩数据
   * @param data 要压缩的数据
   * @param format 压缩格式
   */
  async compress(
    data: Buffer | Uint8Array,
    format: CompressionFormat,
  ): Promise<Buffer> {
    const compressFn = COMPRESSORS[format] ?? ((d: Buffer | Uint8Array) => gzipAsync(d));
    return compressFn(data);
  }

  /**
   * 解压缩
   */
  async decompress(
    data: Buffer | Uint8Array,
    format: CompressionFormat,
  ): Promise<Buffer> {
    const decompressFn = DECOMPRESSORS[format] ?? ((d: Buffer | Uint8Array) => gunzipAsync(d));
    return decompressFn(data);
  }

  // ─── Diff 压缩 ─────────────────────────────────────────────

  /**
   * 压缩 SOP Diff（文档 9.3 节）
   * 使用策略：增量 diff + gzip 组合
   */
  async compressDiff(diff: SopDiff): Promise<Buffer> {
    const json = JSON.stringify(diff);

    // 大 diff 用 brotli（全量同步场景）
    // 小 diff 用 gzip（增量更新场景）
    if (json.length > 1_000_000) {
      return this.compress(Buffer.from(json), CompressionFormat.Brotli);
    }

    return this.compress(Buffer.from(json), CompressionFormat.Gzip);
  }

  /**
   * 解压 SOP Diff
   */
  async decompressDiff(data: Buffer | Uint8Array): Promise<SopDiff> {
    const decompressed = await this.decompressAny(data);
    return JSON.parse(decompressed.toString('utf-8'));
  }

  private async decompressAny(data: Buffer | Uint8Array): Promise<Buffer> {
    try {
      return await gunzipAsync(data);
    } catch {
      try {
        return await brotliDecompressAsync(data);
      } catch {
        return Buffer.from(data);
      }
    }
  }

  /**
   * JSON → CBOR 编码（简化实现）
   * 生产环境请使用 cbor 库
   */
  jsonToCbor(jsonData: unknown): Buffer {
    // CBOR 简化实现：紧凑 JSON + gzip
    // 生产环境替换为: cbor.encode(jsonData)
    const compact = JSON.stringify(jsonData);
    return Buffer.from(compact, 'utf-8');
  }

  /**
   * CBOR → JSON 解码（简化实现）
   */
  cborToJson<T = unknown>(buffer: Buffer): T {
    // 简化实现：直接解析为 JSON 字符串
    // 生产环境替换为: cbor.decode(buffer)
    const text = buffer.toString('utf-8');
    return JSON.parse(text) as T;
  }

  /**
   * 智能选择压缩策略
   */
  selectStrategy(dataSize: number, isFullSync: boolean): CompressionFormat {
    if (isFullSync) {
      return CompressionFormat.Brotli; // 首次全量同步用 brotli（压缩率最高）
    }

    if (dataSize < 10_000) {
      return CompressionFormat.Cbor; // 极小数据用 CBOR
    }

    return CompressionFormat.Gzip; // 增量更新用 gzip（快）
  }
}
