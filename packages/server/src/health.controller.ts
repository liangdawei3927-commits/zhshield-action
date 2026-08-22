import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SopService } from './sop/sop.service';

type CheckStatus = 'ok' | 'degraded';

interface ComponentCheck {
  status: CheckStatus;
  latencyMs?: number;
  detail?: string;
}

type SubsystemChecks = Record<string, ComponentCheck>;

interface CheckResult {
  ok: boolean;
  detail: string;
}

const CHECK_TIMEOUT_MS = 500;
const SERVER_VERSION = '0.2.0';
/** 同步降级 Level 0-3 可接受，Level 4（严重过期）视为不健康 */
const SYNC_HEALTH_FAIL_LEVEL = 4;

@ApiTags('health')
@Controller()
export class HealthController {
  private readonly startTime = Date.now();

  constructor(private readonly sop?: SopService) {}

  @Get('health')
  async health() {
    const subsystems = await this.checkSubsystems();
    return {
      status: this.worstStatus(subsystems),
      timestamp: new Date().toISOString(),
      uptime: this.getUptime(),
      version: SERVER_VERSION,
      subsystems,
    };
  }

  @Get('ready')
  async ready() {
    const subsystems = await this.checkSubsystems();
    const allOk = Object.values(subsystems).every((c) => c.status === 'ok');
    return {
      status: allOk ? 'ready' : 'degraded',
      timestamp: new Date().toISOString(),
      subsystems,
    };
  }

  @Get('live')
  live() {
    return { status: 'alive' };
  }

  private getUptime(): number {
    return Math.floor((Date.now() - this.startTime) / 1000);
  }

  /** 逐组件真实探测：单项 ≤500ms，异常/超时一律降级为 degraded，端点绝不抛出 */
  private async checkSubsystems(): Promise<SubsystemChecks> {
    const [database, sopCache, sopRules, syncHealth] = await Promise.all([
      this.withTimeout('sqlite ping', () => this.pingDatabase()),
      this.withTimeout('local version', () => this.checkLocalVersion()),
      this.withTimeout('rule registry', () => this.checkRegisteredRules()),
      this.withTimeout('sync health', () => this.checkSyncHealth()),
    ]);
    return { database, sopCache, sopRules, syncHealth };
  }

  private async pingDatabase(): Promise<CheckResult> {
    if (!this.sop) return { ok: false, detail: 'SOP service not wired' };
    const cached = await this.sop.getCacheManager().loadRules('guard');
    return { ok: true, detail: `sqlite responded (${cached.length} cached rules in guard)` };
  }

  private async checkLocalVersion(): Promise<CheckResult> {
    if (!this.sop) return { ok: false, detail: 'SOP service not wired' };
    const version = await this.sop.getCacheManager().getLocalVersion();
    return {
      ok: true,
      detail: version ? `local version ${version.version}` : 'cache reachable, no synced version yet',
    };
  }

  private checkRegisteredRules(): CheckResult {
    if (!this.sop) return { ok: false, detail: 'SOP service not wired' };
    const total = this.sop.getAllRules().length;
    return total > 0
      ? { ok: true, detail: `${total} rules registered` }
      : { ok: false, detail: 'no SOP rules registered' };
  }

  private checkSyncHealth(): CheckResult {
    if (!this.sop) return { ok: false, detail: 'SOP service not wired' };
    const level = this.sop.getCacheManager().getSyncHealthLevel();
    return level < SYNC_HEALTH_FAIL_LEVEL
      ? { ok: true, detail: `sync degradation level ${level}` }
      : { ok: false, detail: `sync severely stale (level ${level})` };
  }

  private async withTimeout(label: string, probe: () => Promise<CheckResult> | CheckResult): Promise<ComponentCheck> {
    const start = Date.now();
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        Promise.resolve(probe()),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`${label} timed out after ${CHECK_TIMEOUT_MS}ms`)),
            CHECK_TIMEOUT_MS,
          );
          timer.unref();
        }),
      ]);
      return { status: result.ok ? 'ok' : 'degraded', latencyMs: Date.now() - start, detail: result.detail };
    } catch (err) {
      return {
        status: 'degraded',
        latencyMs: Date.now() - start,
        detail: err instanceof Error ? err.message : String(err),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private worstStatus(subsystems: SubsystemChecks): CheckStatus {
    return Object.values(subsystems).some((c) => c.status === 'degraded') ? 'degraded' : 'ok';
  }
}
