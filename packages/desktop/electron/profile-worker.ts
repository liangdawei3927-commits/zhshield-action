import { parentPort, workerData } from 'node:worker_threads';
import { readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

interface ProfileWorkerData {
  projectPath: string;
  options?: {
    excludeDirs?: string[];
    includeExtensions?: string[];
  };
}

interface ProfileResult {
  files: Array<{ path: string; size: number; ext: string }>;
  stats: {
    totalFiles: number;
    totalSize: number;
    byExtension: Record<string, number>;
  };
}

/**
 * Worker thread for project profiling
 * Moves heavy filesystem operations off the main Electron thread
 */
function collectProjectFiles(
  projectPath: string,
  options?: ProfileWorkerData['options'],
): ProfileResult {
  const excludeDirs = options?.excludeDirs ?? [
    'node_modules', '.git', 'dist', 'build', '.next', 'coverage',
    '__pycache__', '.venv', 'vendor', '.cache',
  ];
  const includeExtensions = options?.includeExtensions ?? [
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
    '.py', '.go', '.rs', '.java', '.kt',
    '.vue', '.svelte', '.astro',
  ];

  const files: ProfileResult['files'] = [];
  const byExtension: Record<string, number> = {};
  let totalSize = 0;

  function walkDir(dir: string): void {
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);

        if (entry.isDirectory()) {
          if (!excludeDirs.includes(entry.name)) {
            walkDir(fullPath);
          }
        } else if (entry.isFile()) {
          const ext = extname(entry.name).toLowerCase();
          if (includeExtensions.includes(ext)) {
            try {
              const stat = statSync(fullPath);
              files.push({ path: fullPath, size: stat.size, ext });
              byExtension[ext] = (byExtension[ext] ?? 0) + 1;
              totalSize += stat.size;
            } catch { /* skip unreadable files */ }
          }
        }
      }
    } catch { /* skip unreadable directories */ }
  }

  walkDir(projectPath);

  return {
    files,
    stats: {
      totalFiles: files.length,
      totalSize,
      byExtension,
    },
  };
}

// Worker entry point: read from workerData, do work, post result
try {
  const data = workerData as ProfileWorkerData;
  const result = collectProjectFiles(data.projectPath, data.options);
  parentPort?.postMessage({ success: true, result });
} catch (err) {
  parentPort?.postMessage({
    success: false,
    error: err instanceof Error ? err.message : String(err),
  });
}
