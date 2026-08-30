import { describe, expect, it } from 'vitest';
import { resolveLockfileCheck, LOCKFILE_CHECKS } from '../pages/dependency-logic';

type LockfileLike = { present: boolean; consistent: boolean; integrityVerified: boolean };

const okLockfile: LockfileLike = { present: true, consistent: true, integrityVerified: true };
const inconsistentLockfile: LockfileLike = { present: true, consistent: false, integrityVerified: true };
const noIntegrityLockfile: LockfileLike = { present: true, consistent: true, integrityVerified: false };
const missingLockfile: LockfileLike = { present: false, consistent: false, integrityVerified: false };

describe('resolveLockfileCheck', () => {
  it('present 恒可判定：true → ok，false → fail', () => {
    expect(resolveLockfileCheck(okLockfile, 'present')).toBe('ok');
    expect(resolveLockfileCheck(missingLockfile, 'present')).toBe('fail');
  });

  it('锁文件存在时 consistent/integrityVerified 按真实值判定 ok / fail', () => {
    expect(resolveLockfileCheck(inconsistentLockfile, 'consistent')).toBe('fail');
    expect(resolveLockfileCheck(noIntegrityLockfile, 'integrityVerified')).toBe('fail');
    expect(resolveLockfileCheck(okLockfile, 'consistent')).toBe('ok');
    expect(resolveLockfileCheck(okLockfile, 'integrityVerified')).toBe('ok');
  });

  it('锁文件缺失时 consistent/integrityVerified 为 na，不与其他失败混淆', () => {
    expect(resolveLockfileCheck(missingLockfile, 'consistent')).toBe('na');
    expect(resolveLockfileCheck(missingLockfile, 'integrityVerified')).toBe('na');
  });

  it('LOCKFILE_CHECKS naKey 逐行独立：consistent/integrityVerified 用行专属文案，present 保留通用', () => {
    const naKeys = Object.fromEntries(LOCKFILE_CHECKS.map((c) => [c.key, c.naKey]));
    expect(naKeys.present).toBe('page.deps.lockfile.notEvaluable');
    expect(naKeys.consistent).toBe('page.deps.lockfile.notEvaluableConsistency');
    expect(naKeys.integrityVerified).toBe('page.deps.lockfile.notEvaluableIntegrity');
  });
});