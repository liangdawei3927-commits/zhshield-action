/**
 * 引擎 API 分片 — 传输层模式检测与 IPC 访问器
 *
 * 提供 isHttpMode / getAPI 两个基础访问器，供主入口 engineApi.ts 与各功能分片
 * 统一判定运行环境（HTTP / IPC）并取得 window.electronAPI，避免跨文件重复定义。
 */

// ─── 模式检测 ─────────────────────────────────────────────

export function isHttpMode(): boolean {
  try {
    return typeof import.meta !== 'undefined' && !!import.meta.env?.VITE_API_BASE;
  } catch {
    return false;
  }
}

export function getAPI() {
  return window.electronAPI;
}
