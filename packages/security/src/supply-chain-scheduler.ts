/** 供应链定时扫描调度配置：扫描间隔（毫秒，缺省 24 小时）与扫描回调 */
export interface SupplyChainScanOptions {
  scanInterval?: number;
  onScan: () => Promise<void>;
}

export class SupplyChainScanScheduler {
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private lastScanTime: Date | null = null;
  private readonly scanInterval: number;
  private readonly onScan: () => Promise<void>;

  constructor(options: SupplyChainScanOptions) {
    this.scanInterval = options.scanInterval ?? 24 * 60 * 60 * 1000;
    this.onScan = options.onScan;
  }

  startPeriodicScan(): void {
    if (this.scanTimer) return;

    this.scanTimer = setInterval(() => {
      void this.runScan();
    }, this.scanInterval);

    void this.runScan();
  }

  stopPeriodicScan(): void {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
  }

  getLastScanTime(): Date | null {
    return this.lastScanTime;
  }

  private async runScan(): Promise<void> {
    try {
      await this.onScan();
      this.lastScanTime = new Date();
    } catch {
      // scan failure should not crash the scheduler
    }
  }
}
