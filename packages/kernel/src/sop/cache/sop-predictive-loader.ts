import type { ProjectFeature } from '../_meta/sop-types';
import type { SopCacheManager } from './sop-cache-manager';
import type { SopLazyLoader } from './sop-lazy-loader';

interface UserActivityProfile {
  userId: string;
  /** 活跃时段（小时, 0-23） */
  activeHours: number[];
  /** 当前项目类型 */
  currentProjectType?: string;
  /** 历史项目类型 */
  projectHistory: string[];
}

/**
 * SopPredictiveLoader — 预测性预加载（文档 9.6 节）
 *
 * 提前把规则送到用户身边：
 * 1. 在非活跃时段预加载
 * 2. 根据项目类型预测下一步可能需要的规则
 */
export class SopPredictiveLoader {
  private cacheManager: SopCacheManager;
  private lazyLoader: SopLazyLoader | undefined;

  constructor(cacheManager: SopCacheManager) {
    this.cacheManager = cacheManager;
    this.lazyLoader = cacheManager.getLazyLoader();
  }

  // ─── 预加载策略 ────────────────────────────────────────────

  /**
   * 执行预加载策略
   */
  async preloadStrategy(userProfile: UserActivityProfile): Promise<PreloadResult> {
    const result: PreloadResult = {
      preloadedModules: [],
      skipped: false,
      reason: '',
    };

    if (this.isActiveHour(userProfile)) {
      result.skipped = true;
      result.reason = 'active_hours';
      return result;
    }

    const syncResult = await this.cacheManager.syncFromCloud();
    if (syncResult.updated) {
      result.preloadedModules.push('*incremental-update');
    }

    if (userProfile.currentProjectType && this.lazyLoader) {
      result.preloadedModules.push(...(await this.preloadNext(userProfile, this.lazyLoader)));
    }

    return result;
  }

  private isActiveHour(profile: UserActivityProfile): boolean {
    const currentHour = new Date().getHours();
    return profile.activeHours.includes(currentHour);
  }

  private async preloadNext(
    profile: UserActivityProfile,
    lazyLoader: SopLazyLoader,
  ): Promise<string[]> {
    const preloaded: string[] = [];
    const feature: ProjectFeature = {
      framework: profile.currentProjectType,
      language: 'typescript',
      features: profile.projectHistory,
    };
    const results = await Promise.all(
      this.predictNextModules(profile).map(() => lazyLoader.syncForProject(feature)),
    );
    for (const r of results) {
      preloaded.push(...r);
    }
    return preloaded;
  }

  /**
   * 预测用户下一步可能需要的模块
   */
  private predictNextModules(profile: UserActivityProfile): string[] {
    const predicted = [...this.predictFromProjectType(profile), ...this.predictFromActiveHours()];
    return [...new Set(predicted)];
  }

  private predictFromProjectType(profile: UserActivityProfile): string[] {
    const predicted: string[] = [];
    const type = profile.currentProjectType?.toLowerCase();

    if (type?.includes('nestjs') || type?.includes('nest')) {
      if (!profile.projectHistory.includes('security')) {
        predicted.push('security');
      }
      if (profile.projectHistory.some((h) => h.includes('typeorm') || h.includes('prisma'))) {
        predicted.push('architecture');
      }
    }

    if (type?.includes('react') || type?.includes('next')) {
      if (profile.projectHistory.length > 2) {
        predicted.push('quality');
      }
    }

    return predicted;
  }

  private predictFromActiveHours(): string[] {
    const currentHour = new Date().getHours();
    return currentHour >= 5 && currentHour <= 7 ? ['security'] : [];
  }
}

interface PreloadResult {
  preloadedModules: string[];
  skipped: boolean;
  reason: string;
}
