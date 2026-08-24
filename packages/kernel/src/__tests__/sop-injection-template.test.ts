import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { SopRegistry } from '../sop/_meta/sop-registry';
import { SopLoader } from '../sop/_meta/sop-loader';

const SOP_RULES_DIR = path.resolve(__dirname, '../sop');

describe('F2 injection SOP 模板注册（security/scan/injection/）', () => {
  it('经 SopLoader.loadFromFileSystem 目录自动发现注册为 security.scan.internal.* 规则', async () => {
    const registry = new SopRegistry();
    const loader = new SopLoader(registry, { rulesDir: SOP_RULES_DIR });
    await loader.loadFromFileSystem();

    const expected = [
      ['security.scan.internal.comment-instruction', 'high'],
      ['security.scan.internal.dependency-scripts', 'critical'],
      ['security.scan.internal.env-exfiltration', 'high'],
      ['security.scan.internal.hidden-link', 'medium'],
    ] as const;

    for (const [ruleId, severity] of expected) {
      const rule = registry.get(ruleId);
      expect(rule, ruleId).toBeDefined();
      expect(rule?.domain).toBe('security');
      expect(rule?.action).toBe('scan');
      expect(rule?.status).toBe('active');
      expect(rule?.severity).toBe(severity);
      expect(rule?.applicableEngines).toContain('security');
    }
  });
});
