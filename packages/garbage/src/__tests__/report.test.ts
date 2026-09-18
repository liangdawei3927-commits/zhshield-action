import { describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { buildGarbageReport, FS_DETECTOR_ID } from '../report';
import {
  GARBAGE_RULE_TYPE_MAP,
  mapRuleIdToGarbageType,
  issuesToGarbageItems,
} from '../item-mapper';
import type { GarbageItem } from '../types';

const DEAD_CODE_RULE = 'garbage.scan.cleanup.dead-code';

function fsItem(p: string, size: number): GarbageItem {
  return { id: p, type: 'build-artifact', path: p, size, reason: '构建产物' };
}

describe('buildGarbageReport', () => {
  it('合并文件系统项与规则项，按体积降序、统计 byType', () => {
    const report = buildGarbageReport({
      projectPath: '/p',
      fsItems: [fsItem('coverage', 1024), fsItem('dist', 4096)],
      evaluations: [
        {
          rule: { id: DEAD_CODE_RULE, name: '死代码检测' },
          status: 'failed',
          violations: [
            {
              id: 'v1',
              ruleId: DEAD_CODE_RULE,
              file: 'src/a.ts',
              line: 3,
              message: '未使用导出 a',
            },
          ],
        },
      ],
    });

    expect(report.summary.total).toBe(3);
    expect(report.summary.size).toBe(5120);
    expect(report.summary.byType).toEqual({ 'build-artifact': 2, 'dead-code': 1 });
    expect(report.items.map((i) => i.path)).toEqual(['dist', 'coverage', 'src/a.ts']);
    expect(report.skipped).toBe(0);
    expect(report.checks[0]).toMatchObject({ ruleId: FS_DETECTOR_ID, ran: true });
  });

  it('规则 skipped / degraded 时计入 skipped 并给出原因（禁止静默当通过）', () => {
    const report = buildGarbageReport({
      projectPath: '/p',
      fsItems: [],
      evaluations: [
        {
          rule: { id: 'garbage.scan.cleanup.duplicate-code', name: '重复代码检测' },
          status: 'skipped',
          message: '工具不可用: jscpd（未安装或在 PATH 中未找到）',
        },
        {
          rule: { id: DEAD_CODE_RULE, name: '死代码检测' },
          status: 'passed',
          degraded: true,
          message: '降级跳过',
        },
      ],
    });

    expect(report.skipped).toBe(2);
    expect(report.summary.total).toBe(0);
    const duplicated = report.checks.find((c) => c.ruleId.includes('duplicate-code'));
    expect(duplicated?.ran).toBe(false);
    expect(duplicated?.reason).toContain('jscpd');
    expect(report.checks.find((c) => c.ruleId === DEAD_CODE_RULE)?.ran).toBe(false);
  });

  it('未登记映射的规则产出必须显式记账，不得静默丢弃', () => {
    const report = buildGarbageReport({
      projectPath: '/p',
      fsItems: [],
      evaluations: [
        {
          rule: { id: 'garbage.scan.cleanup.unknown-thing', name: '未登记规则' },
          status: 'failed',
          violations: [
            {
              id: 'x1',
              ruleId: 'garbage.scan.cleanup.unknown-thing',
              file: 'a.ts',
              message: 'something',
            },
          ],
        },
      ],
    });

    expect(report.summary.total).toBe(0);
    const unmapped = report.checks.find((c) => c.name.includes('未登记映射'));
    expect(unmapped).toBeDefined();
    expect(unmapped?.ran).toBe(false);
    expect(report.skipped).toBe(1);
  });

  it('规则通道未执行时留痕', () => {
    const report = buildGarbageReport({ projectPath: '/p', fsItems: [], ruleChannelRan: false });
    expect(report.skipped).toBe(1);
    expect(report.checks.some((c) => c.ruleId === 'garbage.rules')).toBe(true);
  });
});

describe('规则映射表', () => {
  const RULES_DIR = path.resolve(
    __dirname,
    '../../../kernel/src/sop/presets/sop-templates/garbage/scan/cleanup',
  );

  it('garbage 域已落地的每条规则都在映射表登记（防"规则跑了页面看不到"）', () => {
    const files = fs.existsSync(RULES_DIR)
      ? fs.readdirSync(RULES_DIR).filter((f) => f.endsWith('.yml'))
      : [];
    expect(files.length).toBeGreaterThan(0);
    const ids = files.map((f) => {
      const text = fs.readFileSync(path.join(RULES_DIR, f), 'utf-8');
      const m = /^\s*id:\s*"([^"]+)"/m.exec(text);
      expect(m, `${f} 缺 metadata.id`).not.toBeNull();
      return m![1];
    });
    for (const id of ids) {
      expect(
        mapRuleIdToGarbageType(id),
        `规则 ${id} 未登记到 GARBAGE_RULE_TYPE_MAP`,
      ).not.toBeNull();
    }
  });

  it('映射表不含已删除的规则（防幽灵条目）', () => {
    const files = fs.existsSync(RULES_DIR)
      ? fs.readdirSync(RULES_DIR).filter((f) => f.endsWith('.yml'))
      : [];
    const text = files
      .map((f) => fs.readFileSync(path.join(RULES_DIR, f), 'utf-8'))
      .join('\n')
      .replace(/^#.*$/gm, '');
    for (const id of Object.keys(GARBAGE_RULE_TYPE_MAP)) {
      expect(text, `映射表条目 ${id} 在 garbage 域已无对应规则`).toContain(id);
    }
  });

  it('issuesToGarbageItems 仅转换已登记规则，未登记返回空', () => {
    const items = issuesToGarbageItems([
      { ruleId: DEAD_CODE_RULE, file: 'a.ts', message: 'm' },
      { ruleId: 'not-registered', file: 'b.ts', message: 'm' },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe('dead-code');
    expect(items[0].path).toBe('a.ts');
  });
});
