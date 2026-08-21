import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron';
import path from 'path';

export default defineConfig({
  plugins: [
    react(),
    electron([
      {
        entry: 'electron/main.ts',
        onstart(options) {
          // main 变更时重启 Electron；初始构建若最后一个完成也由此拉起
          options.startup();
        },
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              // pipeline-host / protocol 随 main 打包；@zh/* 运行时从 node_modules 加载
              external: ['electron', /^@zh\//],
            },
          },
        },
      },
      {
        entry: 'electron/preload.ts',
        onstart(options) {
          options.reload();
        },
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: ['electron', /^@zh\//],
            },
          },
        },
      },
      {
        // 体检子进程：独立入口，由 pipeline-host fork
        entry: 'electron/pipeline-worker.ts',
        onstart(options) {
          // 不重启 Electron 主进程；初始构建若最后完成则由此拉起
          options.reload();
        },
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: ['electron', /^@zh\//],
            },
          },
        },
      },
      {
        // OpenCode MCP server：独立入口，由 OpenCode 以 node 启动（stdio）
        entry: 'electron/zhshield-mcp.ts',
        onstart(options) {
          // 不重启 Electron 主进程；初始构建若最后完成则由此拉起
          options.reload();
        },
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: ['electron', /^@zh\//],
            },
          },
        },
      },
    ]),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      // 渲染进程为沙箱环境（nodeIntegration:false）：@zh 包必须解析到浏览器安全入口，
      // 不能落到 CommonJS + Node 内置模块的 dist 产物（会导致 ESM 链接失败 → 白屏）
      '@zh/kernel': path.resolve(__dirname, '../kernel/src/browser.ts'),
      '@zh/reporter': path.resolve(__dirname, '../reporter/src/index.ts'),
      '@zh/fingerprint': path.resolve(__dirname, '../fingerprint/src/index.ts'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      ignored: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/dist-electron/**'],
      followSymlinks: false,
    },
  },
  optimizeDeps: {
    exclude: [
      'electron',
      '@zh/kernel',
      '@zh/guard',
      '@zh/inspect',
      '@zh/security',
      '@zh/refactor',
      '@zh/pipeline',
      '@zh/sentinel',
      '@zh/evolve',
    ],
  },
  build: {
    outDir: 'dist',
    commonjsOptions: {
      include: [/node_modules/, /[\\/]packages[\\/][^\\/]+[\\/]dist[\\/]/],
    },
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom'],
        },
      },
    },
  },
});
