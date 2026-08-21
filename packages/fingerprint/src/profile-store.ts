// 画像持久化层（架构文档 §7.2）：读写 JSON + overrides 合并 + 缓存
// 持久化到 ~/.zhshield/profiles/（Desktop 项目注册表 / 用户目录）

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { ProjectProfile, UserOverrides } from './types';

// ─── 常量 ───

/** 持久化目录名 */
const PROFILE_DIR = '.zhshield';

/** 画像文件名 */
const _PROFILE_FILE = 'profile.json';

/** 缓存过期时间（毫秒）：5 分钟 */
const CACHE_TTL_MS = 5 * 60 * 1000;

// ─── 内部类型 ───

/** 缓存条目 */
interface CacheEntry {
  readonly profile: ProjectProfile;
  readonly timestamp: number;
}

/** 最小事件总线接口（避免依赖 @zh/kernel 产生循环引用） */
export interface ProfileEventBus {
  emit(event: string, data: unknown): void | Promise<void>;
}

// ─── ProfileStore 类 ───

export class ProfileStore {
  private readonly cache: Map<string, CacheEntry> = new Map();
  private readonly baseDir: string;
  private readonly eventBus?: ProfileEventBus;

  constructor(baseDir?: string, eventBus?: ProfileEventBus) {
    this.baseDir = baseDir ?? path.join(os.homedir(), PROFILE_DIR, 'profiles');
    this.eventBus = eventBus;
  }

  /**
   * 加载项目画像
   * @param projectPath 项目根路径（用于生成存储 key）
   * @returns ProjectProfile 或 undefined（未持久化）
   */
  load(projectPath: string): ProjectProfile | undefined {
    const key = this.normalizeKey(projectPath);

    // 检查缓存
    const cached = this.cache.get(key);
    if (cached !== undefined && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return cached.profile;
    }

    // 从文件系统读取
    const filePath = this.getFilePath(projectPath);
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const profile = JSON.parse(content) as ProjectProfile;

      // 验证 schema 版本
      if (profile.schemaVersion !== 1) {
        // 版本不兼容，返回 undefined
        return undefined;
      }

      // 更新缓存
      this.cache.set(key, { profile, timestamp: Date.now() });

      return profile;
    } catch {
      // 文件不存在或解析失败
      return undefined;
    }
  }

  /**
   * 保存项目画像
   * @param projectPath 项目根路径
   * @param profile ProjectProfile
   */
  save(projectPath: string, profile: ProjectProfile): void {
    const key = this.normalizeKey(projectPath);
    const filePath = this.getFilePath(projectPath);

    // 确保目录存在
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // 写入文件
    fs.writeFileSync(filePath, JSON.stringify(profile, null, 2), 'utf-8');

    // 更新缓存
    this.cache.set(key, { profile, timestamp: Date.now() });
  }

  /**
   * 合并人工修正并保存
   * @param projectPath 项目根路径
   * @param overrides 人工修正记录
   * @returns 合并后的 ProjectProfile
   */
  mergeOverridesAndSave(projectPath: string, overrides: UserOverrides): ProjectProfile {
    const existing = this.load(projectPath);
    let mergedProfile: ProjectProfile;

    if (existing === undefined) {
      mergedProfile = {
        schemaVersion: 1,
        architecture: { value: 'unknown', confidence: 0, signals: [] },
        targets: [],
        environments: [],
        dependencies: { direct: [] },
        detectedAt: new Date().toISOString(),
        lastConfirmedAt: new Date().toISOString(),
        stale: false,
        signals: [],
        overrides,
      };
    } else {
      const mergedOverrides = this.mergeUserOverrides(existing.overrides, overrides);
      mergedProfile = {
        ...existing,
        overrides: mergedOverrides,
        lastConfirmedAt: new Date().toISOString(),
        stale: false,
      };
    }

    this.save(projectPath, mergedProfile);
    this.eventBus?.emit('profile:confirmed', { projectPath, profile: mergedProfile });
    return mergedProfile;
  }

  /**
   * 检查画像是否存在
   * @param projectPath 项目根路径
   */
  exists(projectPath: string): boolean {
    const filePath = this.getFilePath(projectPath);
    return fs.existsSync(filePath);
  }

  /**
   * 删除项目画像
   * @param projectPath 项目根路径
   */
  delete(projectPath: string): void {
    const key = this.normalizeKey(projectPath);
    const filePath = this.getFilePath(projectPath);

    try {
      fs.unlinkSync(filePath);
    } catch {
      // 文件不存在，忽略
    }

    this.cache.delete(key);
  }

  /**
   * 清除所有缓存
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * 获取所有已持久化的项目画像
   * @returns 项目路径 → ProjectProfile 映射
   */
  listAll(): Map<string, ProjectProfile> {
    const result = new Map<string, ProjectProfile>();

    try {
      if (!fs.existsSync(this.baseDir)) {
        return result;
      }

      const files = fs.readdirSync(this.baseDir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;

        const filePath = path.join(this.baseDir, file);
        try {
          const content = fs.readFileSync(filePath, 'utf-8');
          const profile = JSON.parse(content) as ProjectProfile;

          // 从文件名反推项目路径（简化版：使用文件名作为 key）
          const projectPath = file.replace('.json', '');
          result.set(projectPath, profile);
        } catch {
          // 解析失败，跳过
        }
      }
    } catch {
      // 目录不存在，返回空映射
    }

    return result;
  }

  // ─── 内部方法 ───

  /** 获取画像文件路径 */
  private getFilePath(projectPath: string): string {
    const key = this.normalizeKey(projectPath);
    return path.join(this.baseDir, `${key}.json`);
  }

  /** 规范化存储 key（将路径转为安全的文件名） */
  private normalizeKey(projectPath: string): string {
    // 替换路径分隔符为下划线，去掉开头的下划线
    return projectPath
      .replace(/\//g, '_')
      .replace(/\\/g, '_')
      .replace(/^_+/, '')
      .replace(/[^a-zA-Z0-9_-]/g, '_');
  }

  /** 合并 UserOverrides */
  private mergeUserOverrides(
    existing: UserOverrides,
    incoming: UserOverrides,
  ): UserOverrides {
    const mergedTargets =
      existing.targets !== undefined || incoming.targets !== undefined
        ? { ...existing.targets, ...incoming.targets }
        : undefined;

    return {
      ...existing,
      ...incoming,
      ...(mergedTargets !== undefined ? { targets: mergedTargets } : {}),
      updatedAt: new Date().toISOString(),
    };
  }
}

// ─── 导出工厂函数 ───

/**
 * 创建 ProfileStore 实例
 * @param baseDir 存储目录（默认 ~/.zhshield/profiles/）
 * @param eventBus 可选事件总线（提供时 mergeOverridesAndSave 会 emit profile:confirmed）
 */
export function createProfileStore(baseDir?: string, eventBus?: ProfileEventBus): ProfileStore {
  return new ProfileStore(baseDir, eventBus);
}
