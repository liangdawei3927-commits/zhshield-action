/**
 * 按能力注册表渲染「本域能做什么」清单。
 *
 * ## 为什么需要这个组件
 *
 * 空态页的 `features` 数组原本是**手写的 i18n key 列表**，与真实能力无任何关联：
 *   · 性能页宣称 4 项（复杂度 / ReDoS / 现代化 API / 定时器优化），
 *     实际只有 1 项有探测器 —— ReDoS 依赖的规则文件不存在，另两项无实现。
 *   · 安全页宣称「规范检查」，全仓无实现。
 *   · 垃圾页宣称「重复代码」，但按《07》O1 已唯一归重构域。
 *
 * 用户看到的能力清单与真实能力不符，且**没有任何异常提示** —— 这是信任级缺陷。
 *
 * ## 本组件的做法
 *
 * 能力清单来自 `@zh/shared` 的 `CAPABILITY_REGISTRY`（单一事实源），
 * 且**只渲染 `status === 'implemented'` 的能力**。
 *
 * 渲染层不做判断：判断在注册表里。若在这里写 `if (status === 'implemented')`，
 * 就等于有了第二份口径 —— 那正是本组件要消灭的东西。
 *
 * 代价与收益：
 *   · 代价：文案从 i18n 改为注册表里的 `label`（中文），失去多语言。
 *     这是**有意的取舍**：能力清单当前只有 zh-Hans 有内容（其余语言包未同步），
 *     而"宣称了却没有"比"文案没翻译"严重得多。
 *   · 收益：新增能力只需在注册表登记；忘记实现 → 测试变红；
 *     UI 永远不会宣称未实现的能力。
 */

import type { ReactNode } from 'react';

import { implementedCapabilities, unimplementedCapabilities } from '@zh/shared';
import type { CapabilityDeclaration, CapabilityStatus, DomainId } from '@zh/shared';

/** 单个能力的展示项（icon 由调用方提供 —— 图标是纯视觉，不进注册表） */
export interface CapabilityFeatureItem {
  /** 能力 id */
  id: string;
  /** 能力名 */
  title: string;
  /** 能力说明 */
  desc: string;
  /** 能力图标 */
  icon: ReactNode;
}

/** 能力注册表里的能力 → 展示项（文案取自注册表，图标由调用方提供） */
export interface CapabilityFeatureSource {
  /** 能力 id → 图标 */
  icons: Readonly<Record<string, ReactNode>>;
  /** 能力 id → 说明文案（可选；缺省用注册表的 label） */
  descriptions?: Readonly<Record<string, string>>;
}

/**
 * 取某域已实现的能力，并组装成展示项。
 *
 * @param domain  治理域
 * @param source  图标与补充文案
 */
export function buildCapabilityFeatures(
  domain: DomainId,
  source: CapabilityFeatureSource,
): CapabilityFeatureItem[] {
  const caps: readonly CapabilityDeclaration[] = implementedCapabilities(domain);
  return caps.map((cap) => ({
    id: cap.id,
    title: cap.label,
    desc: source.descriptions?.[cap.id] ?? cap.label,
    icon: source.icons[cap.id] ?? <span key={cap.id} />,
  }));
}

/** 「规划中 / 已移交」能力展示项：UI **不得**把它们当作可宣称能力渲染 */
export interface CapabilityPlannedItem {
  /** 能力 id */
  id: string;
  /** 能力名（注册表 label） */
  title: string;
  /** 未实现原因（注册表 note，缺省给一句话兜底） */
  desc: string;
  /** 状态：planned（尚未实现）/ deprecated（已移交他域） */
  status: Exclude<CapabilityStatus, 'implemented'>;
}

/**
 * 取某域**未实现**的能力（planned / deprecated），供空态以「规划中（不宣称）」灰显区展示。
 *
 * 与 {@link buildCapabilityFeatures}（只给已实现）互补：这条路径让用户也能看见
 * 「这个域宣称过、但当前不做/暂未做」的清单 —— 此前这份清单只有 CLI
 * （`zhshield capability` / `--format json`）能看到，桌面端看不到。
 *
 * 它**不是**可宣称能力：渲染层必须把它放在独立的「规划中」区，绝不能并入功能网格。
 */
export function buildPlannedCapabilities(domain: DomainId): CapabilityPlannedItem[] {
  return unimplementedCapabilities(domain).map((cap) => ({
    id: cap.id,
    title: cap.label,
    desc:
      cap.note ??
      (cap.status === 'deprecated' ? '已移交其他治理域，本域不再宣称' : '规划中：尚未实现'),
    // unimplementedCapabilities 只返回非 implemented 项，此处收窄类型
    status: cap.status as Exclude<CapabilityStatus, 'implemented'>,
  }));
}
