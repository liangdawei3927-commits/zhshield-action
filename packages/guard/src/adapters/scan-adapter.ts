import type { Adapter, CheckConfig, CheckResult, GuardContext } from '../types';
import { runScanAdapter } from './adapter-result';

/**
 * 扫描型适配器基类：把 run() 骨架（解析扫描目录 → 累积 findings → 异常转 error 字段）收敛为唯一实现。
 *
 * 安全扫描与敏感信息两个适配器的 run() 曾逐字重复，差异只在 scanProject 内部，故子类只需实现
 * scanProject（受保护）与 normalize 即可，保持各自原有的 Finding 形状与错误语义不变。
 */
export abstract class ScanAdapter<TFinding> implements Adapter {
  run(context: GuardContext, check: CheckConfig): { findings: TFinding[]; error?: string } {
    return runScanAdapter(context, check.checkId, (targetDir, findings) =>
      this.scanProject(targetDir, findings),
    );
  }

  abstract normalize(rawResult: unknown, context: GuardContext, check: CheckConfig): CheckResult;

  /** 扫描目标目录，把命中项累积进 findings（子类实现） */
  protected abstract scanProject(targetDir: string, findings: TFinding[]): void;
}
