import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseFile } from '../ast-helper';
import { DEFAULT_CONFIG } from '../types';
import { detectDataClumps } from '../adapters/coupling-detectors';

// 源文件写在工作区之外，避开 isTestFixture（排除 __tests__ / fixtures）对检测器的豁免，
// 否则测试夹具路径会让断言口径失真（与 data-class.test.ts 同一做法）。
const SRC = `
type ResLike = { json(body: unknown): void };
type SignedPackage = { manifest: unknown };
type CryptoKeyLike = { id: string };
type VerifyOptions = { windowMs?: number };
type ImportPayload = { rows: string[][] };
type AuditPayload = { action: string };
type RequestContext = { traceId: string };

export class RoutedAdminController {
  ruleSave(@Param('id') id: string, @Body() body: Record<string, unknown>, @Res() res: ResLike): void {
    this.store.save(id, body);
    res.json({ ok: true });
  }

  ruleRollback(@Param('id') id: string, @Body() body: Record<string, unknown>, @Res() res: ResLike): void {
    this.store.rollback(id, body);
    res.json({ ok: true });
  }

  ruleStatus(@Param('id') id: string, @Body() body: Record<string, unknown>, @Res() res: ResLike): void {
    this.store.status(id, body);
    res.json({ ok: true });
  }
}

export class SopVerifyFacade {
  verifyPackage(pkg: SignedPackage, key: CryptoKeyLike, opts: VerifyOptions): boolean {
    const digest = this.hash(pkg.manifest);
    return this.core.verify(digest, key.id, opts.windowMs ?? 0);
  }

  @deprecated('use verifyPackage')
  verifyPackageWithPublicKey(pkg: SignedPackage, key: CryptoKeyLike, opts: VerifyOptions): boolean {
    return SopVerifyFacade.verifyPackage(pkg, key, opts);
  }

  @deprecated('use verifyPackage')
  verifyPackageWithKey(pkg: SignedPackage, key: CryptoKeyLike, opts: VerifyOptions): boolean {
    return SopVerifyFacade.verifyPackage(pkg, key, opts);
  }

  verifyPackageScoped(pkg: SignedPackage, key: CryptoKeyLike, opts: VerifyOptions): boolean {
    return SopVerifyFacade.verifyPackage(pkg, key, opts);
  }
}

export class ReportService {
  exportReport(userId: string, tenantId: string, range: Date): void {
    this.logger.info('export');
    this.queue.push(userId, tenantId, range);
  }

  archiveReport(userId: string, tenantId: string, range: Date): void {
    this.logger.info('archive');
    this.queue.push(userId, tenantId, range);
  }

  purgeReport(userId: string, tenantId: string, range: Date): void {
    this.logger.info('purge');
    this.queue.push(userId, tenantId, range);
  }
}

export class ImportService {
  importRows(@Body() payload: ImportPayload, tenantId: string, actorId: string): void {
    this.logger.info('importRows');
    this.queue.push(payload, tenantId, actorId);
  }

  previewRows(@Body() payload: ImportPayload, tenantId: string, actorId: string): void {
    this.logger.info('previewRows');
    this.queue.push(payload, tenantId, actorId);
  }

  discardRows(@Body() payload: ImportPayload, tenantId: string, actorId: string): void {
    this.logger.info('discardRows');
    this.queue.push(payload, tenantId, actorId);
  }
}

export class AuditTrail {
  record(@Trace() payload: AuditPayload, tenantId: string, actorId: string): void {
    this.logger.info('record');
    this.queue.push(payload, tenantId, actorId);
  }

  replay(@Trace() payload: AuditPayload, tenantId: string, actorId: string): void {
    this.logger.info('replay');
    this.queue.push(payload, tenantId, actorId);
  }

  expire(@Trace() payload: AuditPayload, tenantId: string, actorId: string): void {
    this.logger.info('expire');
    this.queue.push(payload, tenantId, actorId);
  }
}

export class WidgetGateway {
  renderWidget(payload: Record<string, unknown>, ctx: RequestContext, actor: string): string {
    this.logger.info('render');
    return this.template.fill(payload, ctx, actor);
  }

  hydrateWidget(payload: Record<string, unknown>, ctx: RequestContext, actor: string): string {
    this.logger.info('hydrate');
    return this.template.fill(payload, ctx, actor);
  }

  disposeWidget(payload: Record<string, unknown>, ctx: RequestContext, actor: string): string {
    this.logger.info('dispose');
    return this.template.fill(payload, ctx, actor);
  }
}
`;

const TMP = path.join(os.tmpdir(), 'zh-data-clumps-detector-target.ts');

function smellsForClass(): ReturnType<typeof detectDataClumps> {
  return detectDataClumps(parseFile(TMP), DEFAULT_CONFIG);
}

describe('detectDataClumps', () => {
  beforeAll(() => {
    fs.writeFileSync(TMP, SRC, 'utf-8');
  });

  afterAll(() => {
    try {
      fs.unlinkSync(TMP);
    } catch {
      /* 清理失败不影响断言 */
    }
  });

  it('exempts framework injection signatures (every param decorated with @Param/@Body/@Res)', () => {
    const smells = smellsForClass();
    expect(smells.some((s) => s.message.includes('RoutedAdminController'))).toBe(false);
  });

  it('exempts pure single-line delegating aliases with matching arity', () => {
    const smells = smellsForClass();
    expect(smells.some((s) => s.message.includes('SopVerifyFacade'))).toBe(false);
  });

  it('still flags a genuine clump of non-decorated domain methods', () => {
    const smells = smellsForClass();
    expect(
      smells.some((s) => s.ruleId === 'data-clumps' && s.message.includes('ReportService')),
    ).toBe(true);
  });

  it('still flags a mixed signature where only some params are decorated', () => {
    const smells = smellsForClass();
    expect(smells.some((s) => s.message.includes('ImportService'))).toBe(true);
  });

  it('still flags params carrying non-injection decorators only', () => {
    const smells = smellsForClass();
    expect(smells.some((s) => s.message.includes('AuditTrail'))).toBe(true);
  });

  it('renders the parameter type list intact (Record<string, unknown> keeps a single space and the third param stays visible)', () => {
    const smells = smellsForClass();
    const clump = smells.find((s) => s.message.includes('WidgetGateway'));
    expect(clump).toBeDefined();
    expect(clump!.message).toContain('Record<string, unknown>');
    expect(clump!.message).not.toContain('Record<string,  unknown>');
    expect(clump!.message).toContain('RequestContext');
  });
});
