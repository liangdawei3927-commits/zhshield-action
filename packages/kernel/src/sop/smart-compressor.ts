export interface CompressionStrategy {
  name: string;
  minSize: number;
  compress: (data: string) => string;
  decompress: (data: string) => string;
}

export interface CompressedData {
  strategy: string;
  originalSize: number;
  compressedSize: number;
  data: string;
}

export class SmartCompressor {
  private strategies: CompressionStrategy[] = [
    {
      name: 'json-minify',
      minSize: 100,
      compress: (data) => JSON.stringify(JSON.parse(data)),
      decompress: (data) => JSON.stringify(JSON.parse(data), null, 2),
    },
  ];

  /**
   * 智能压缩：根据数据特征选择最佳策略
   */
  compress(data: string): CompressedData {
    const strategy = this.selectStrategy(data);
    const compressed = strategy.compress(data);

    return {
      strategy: strategy.name,
      originalSize: data.length,
      compressedSize: compressed.length,
      data: compressed,
    };
  }

  /**
   * 解压缩
   */
  decompress(compressed: CompressedData): string {
    const strategy = this.strategies.find((s) => s.name === compressed.strategy);
    if (!strategy) throw new Error(`Unknown compression strategy: ${compressed.strategy}`);
    return strategy.decompress(compressed.data);
  }

  private selectStrategy(data: string): CompressionStrategy {
    // 选择压缩率最高的策略
    let bestStrategy = this.strategies[0]!;
    let bestRatio = 1;

    for (const strategy of this.strategies) {
      if (data.length < strategy.minSize) continue;
      const compressed = strategy.compress(data);
      const ratio = compressed.length / data.length;
      if (ratio < bestRatio) {
        bestRatio = ratio;
        bestStrategy = strategy;
      }
    }

    return bestStrategy;
  }
}
