/**
 * 工具命令解析 — 已下沉至 @zh/shared（本文件保留为兼容 shim）
 *
 * 动机（P0-6 工具消费路径不统一）：解析逻辑此前只住在 @zh/inspect，于是
 * Security / Guard 只能各写一套（而且是裸命令，只认 PATH），同一份工具在不同
 * 分类下得出两种结论。下沉到 @zh/shared 后三个包共用同一实现。
 *
 * 本文件仅做转发，保留 @zh/inspect 内部既有 `import ... from './tool-bin'` 路径
 * 与对外导出（inspect/src/index.ts）不变。
 *
 * ⚠️ 新代码请直接从 @zh/shared 导入，不要新增对本 shim 的依赖。
 * 解析顺序与「为何码盾目录优先于 PATH」的说明见 @zh/shared 的 tool-resolve.ts。
 */
export {
  findLocalToolBin,
  findZhshieldToolBin,
  getZhshieldToolBinDir,
  resolveToolCommand,
  resolveToolCommandDetailed,
} from '@zh/shared';
export type { ToolCommandOrigin, ResolvedToolCommand } from '@zh/shared';
