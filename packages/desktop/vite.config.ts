import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron';
import { readFileSync } from 'node:fs';
import path from 'path';

/**
 * 应用版本号的唯一真源：`packages/desktop/package.json` 的 `version`。
 *
 * 编译期注入 `__APP_VERSION__` 给渲染进程用，好处是「改版本只改 package.json 一处」：
 * - electron-builder 从同一字段写 Info.plist 的 `CFBundleShortVersionString`；
 * - 运行时 `app.getVersion()` 读的也是它。
 * 三者同源，所以侧边栏、Finder 显示、更新比对不会各说各话。
 *
 * 历史上 UI 里写死过 `'v0.1.0'`，package.json 已到 0.2.0 而界面还报 0.1.0 —— 正是
 * 「同一事实存多份」导致的漂移，故改为单一来源注入。
 */
const desktopPkg = JSON.parse(
  readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8'),
) as { version?: string };
const APP_VERSION = desktopPkg.version ?? '0.0.0';

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
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
        // 画像 worker 线程：独立入口，由 profile-host 以 worker_threads 启动
        entry: 'electron/profile-worker.ts',
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
      ignored: [
        '**/node_modules/**',
        '**/.git/**',
        '**/dist/**',
        '**/dist-electron/**',
        // 翻译目录由 merge-fragments 等脚本批量写入（一次写 5 个 JSON）。
        // 若不忽略：每次写入都会触发 HMR 风暴 → i18n.tsx 无法 Fast Refresh
        // （导出 useI18n hook）被 invalidate → 整页 reload 竞态中新旧模块并存,
        // 旧 I18nProvider + 新 useI18n 的 context 引用断裂 → “useI18n 必须在
        // I18nProvider 内使用” 白屏。翻译变更低频，改后手动刷新页面生效（可接受）。
        '**/packages/i18n/locales/**',
      ],
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
