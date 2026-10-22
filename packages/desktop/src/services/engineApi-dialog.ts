/**
 * 引擎 API 分片 — 原生对话框 & 文件写入：保存对话框与文本文件落盘
 *
 * 走 Electron IPC，无 Electron API 时返回取消 / 静默降级。
 */
import { getAPI } from './engineApi-transport';

// ─── 原生对话框 & 文件写入 ─────────────────────────────────

export async function showSaveDialog(options: {
  defaultPath: string;
  filters: Array<{ name: string; extensions: string[] }>;
}): Promise<{ canceled: boolean; filePath?: string }> {
  const api = getAPI();
  if (!api) return { canceled: true };
  return api.showSaveDialog(options);
}

export async function writeFile(filePath: string, content: string): Promise<void> {
  const api = getAPI();
  if (!api) return;
  return api.writeFile(filePath, content);
}
