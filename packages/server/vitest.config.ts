import ts from 'typescript';
import type { Plugin } from 'vite';
import { makeVitestConfig } from '../shared/src/vitest.config.base';

/**
 * esbuild 不支持 emitDecoratorMetadata（NestJS DI 依赖 design:paramtypes）。
 * 该插件仅对含装饰器的 .ts 文件改用 TypeScript 编译器转译，产出装饰器元数据。
 */
function decoratorMetadataPlugin(): Plugin {
  return {
    name: 'zh:ts-decorator-metadata',
    enforce: 'pre',
    transform(code, id) {
      if (!id.endsWith('.ts') || id.includes('node_modules') || id.endsWith('.d.ts')) {
        return;
      }
      if (!/@[A-Za-z]/.test(code)) {
        return;
      }
      const out = ts.transpileModule(code, {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
          esModuleInterop: true,
        },
        fileName: id,
      });
      return { code: out.outputText, map: null };
    },
  };
}

export default makeVitestConfig({
  plugins: [decoratorMetadataPlugin()],
  test: {
    environment: 'node',
    testTimeout: 60000,
    coverage: {
      exclude: ['src/main.ts'],
    },
  },
});