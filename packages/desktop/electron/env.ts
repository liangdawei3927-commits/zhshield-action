/**
 * PATH 补全（Electron 入口薄壳）
 *
 * 实现已下沉到 @zh/shared/path-augment；此处保留 __dirname 作为
 * workspace node_modules/.bin 的发现起点（GUI 启动时 cwd 可能是 /）。
 */
import { augmentProcessPath as augmentProcessPathShared } from '@zh/shared';

export function augmentProcessPath(): void {
  augmentProcessPathShared(__dirname);
}
