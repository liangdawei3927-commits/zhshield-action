import { describe, it, expect } from 'vitest';
import * as path from 'node:path';

import { CLEAN_ARCH_LAYERS } from '@zh/shared';
import { ContentInterpreter } from '../runner';
import { SopRegistry } from '../sop/_meta/sop-registry';
import { SopLoader } from '../sop/_meta/sop-loader';
import type { SopRule } from '../sop/_meta/sop-types';

/**
 * 架构分层规则「单一来源」守卫（2026-09-18 建立，T8 口径统一）
 *
 * 同一处层间违规，在门禁（提交时拦住）与项目体检（全面治理）必须给出相同结论。
 * 此前两处各写一份层级定义：
 *   - 门禁适配器内联 4 层 rank 模型（domain←application←infrastructure←presentation，
 *     违反条件为「内层引用外层」）——层名不匹配的 services / adapters / shared 直接跳过；
 *   - 体检规则内联 7 层 allowlist 模型。
 * 对同一份代码两边结论可能不同；且门禁域自己那条架构规则还是 draft（从未执行）。
 *
 * 现在层级表的唯一来源是 `@zh/shared` 的 `CLEAN_ARCH_LAYERS`：两条规则 YAML 的
 * `check.layers` 必须与它逐字一致，门禁侧的 ArchitectureBoundaryAdapter 也必须用它。
 * 本测试锁死这几处的一致性——任何一处单独改动都会在这里变红。
 */
const PRESETS_DIR = path.resolve(__dirname, '../sop/presets/sop-templates');

/** 必须与 CLEAN_ARCH_LAYERS 同源的两条规则（门禁 + 体检） */
const ARCH_RULE_IDS = [
  'guard.block.depcruiser.architecture',
  'inspect.scan.depcruiser.layer-boundary',
] as const;

async function loadRegistry(): Promise<SopRegistry> {
  const registry = new SopRegistry();
  const loader = new SopLoader(registry, { rulesDir: PRESETS_DIR });
  await loader.loadFromFileSystem();
  return registry;
}

/** 取规则解释后的层表（直接消费解释器产出，避免测试重复实现解析） */
function layersOf(rule: SopRule): unknown {
  const instr = new ContentInterpreter().interpret(rule);
  if (instr.type !== 'layer-boundary') {
    throw new Error(
      `规则 ${rule.id} 未解释为 layer-boundary，实际 ${instr.type}（层级表不会被任何执行器使用）`,
    );
  }
  return instr.layers;
}

describe('架构分层规则 — 跨域单一来源', () => {
  it('门禁与体检两条规则的 check.layers 与 CLEAN_ARCH_LAYERS 逐字一致', async () => {
    const registry = await loadRegistry();
    for (const id of ARCH_RULE_IDS) {
      const rule = registry.get(id);
      expect(rule, `规则 ${id} 未加载`).toBeDefined();
      expect(layersOf(rule!), `${id} 的层表与 CLEAN_ARCH_LAYERS 不一致`).toEqual(CLEAN_ARCH_LAYERS);
    }
  });

  it('门禁域架构规则进入执行集（draft 等于门禁根本不检查架构）', async () => {
    const registry = await loadRegistry();
    expect(registry.getActive().map((r) => r.id)).toContain('guard.block.depcruiser.architecture');
  });
});
