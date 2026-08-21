import { Controller, Get } from '@nestjs/common';

type SubsystemCheck = { status: 'ok' };

@Controller()
export class HealthController {
  private readonly startTime: number;

  constructor() {
    this.startTime = Date.now();
  }

  private getUptime(): number {
    return Math.floor((Date.now() - this.startTime) / 1000);
  }

  private getSubsystemStatuses(): Record<string, SubsystemCheck> {
    return {
      database: { status: 'ok' },
      sopSync: { status: 'ok' },
      cache: { status: 'ok' },
      network: { status: 'ok' },
    };
  }

  @Get('health')
  health() {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: this.getUptime(),
      version: '0.2.0',
      subsystems: this.getSubsystemStatuses(),
    };
  }

  @Get('ready')
  ready() {
    const subsystems = this.getSubsystemStatuses();
    const allUp = Object.values(subsystems).every((s) => s.status === 'ok');
    return {
      status: allUp ? 'ready' : 'degraded',
      timestamp: new Date().toISOString(),
      subsystems,
    };
  }

  @Get('live')
  live() {
    return { status: 'alive' };
  }
}
