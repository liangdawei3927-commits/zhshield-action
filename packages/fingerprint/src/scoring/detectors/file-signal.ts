/**
 * 探测器信号推入助手。
 *
 * 语言探测器与包管理器探测器里，大量「若存在某配置文件则推入一条 config-file 信号」
 * 的函数结构完全相同，只是文件名与 inferred 不同。抽到此处统一，避免逐函数重复样板。
 */
import type { ProfileSignal } from '../types';
import type { ScanResult } from '../file-scanner';
import { hasFile } from '../file-scanner';

/**
 * 若扫描命中某配置文件，则推入一条 config-file 信号（`matched` 恒为文件名本身）。
 *
 * 不收 `matched` 覆盖参数：9 处调用无一传它，而「命中文件 ≠ 信号文件名」在
 * config-file 这一类信号里不存在（那是扩展名/内容类信号的形态）。
 */
export function pushFileSignal(
  scan: ScanResult,
  signals: ProfileSignal[],
  file: string,
  inferred: ProfileSignal['inferred'],
): void {
  if (hasFile(scan, file)) {
    signals.push({ file, kind: 'config-file', matched: file, inferred });
  }
}
