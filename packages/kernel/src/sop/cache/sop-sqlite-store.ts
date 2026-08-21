import { DbConnection } from '@zh/db';
import type { SopRule } from '../_meta/sop-types';
import type { EncryptedData } from '../security/sop-signer';

/**
 * 加密配置（可选）：提供此选项时，规则将以 AES-256-GCM 加密后写入 SQLite。
 */
export interface SopSqliteStoreEncryptionOptions {
  /** 机器硬件指纹（用于密钥派生） */
  machineFingerprint: string;
  /** 用户 ID（用于密钥派生） */
  userId: string;
}

// better-sqlite3 类型内联，避免 native 模块在非 Electron 环境下的构建问题
interface Database {
  prepare(sql: string): Statement;
  exec(sql: string): void;
  close(): void;
  transaction<TArgs extends unknown[], TResult>(fn: (...args: TArgs) => TResult): (...args: TArgs) => TResult;
}
interface Statement {
  run(...params: unknown[]): { changes: number };
  get<T = unknown>(...params: unknown[]): T | undefined;
  all<T = unknown>(...params: unknown[]): T[];
  iterate<T = unknown>(...params: unknown[]): IterableIterator<T>;
}

/**
 * SopSqliteStore — 本地规则 SQLite 存储
 *
 * 负责 sop_rules 表的建表、查询、事务持久化与清空。
 */
export class SopSqliteStore {
  private db: Database | null = null;

  constructor(
    private readonly dbPath: string,
    private readonly encryption?: SopSqliteStoreEncryptionOptions,
  ) {}

  /**
   * 初始化数据库连接和表结构
   */
  initialize(): void {
    const conn = new DbConnection({ dbPath: this.dbPath, walMode: true });
    this.db = conn.connect() as unknown as Database;

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sop_rules (
        id        TEXT PRIMARY KEY,
        domain    TEXT NOT NULL,
        action    TEXT NOT NULL,
        data      TEXT NOT NULL,
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);

    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_sop_rules_domain ON sop_rules(domain)`);
  }

  /**
   * 从本地 SQLite 缓存加载全部规则
   */
  loadAll(): SopRule[] {
    if (!this.db) return [];
    try {
      const rows = this.db.prepare('SELECT data FROM sop_rules').all() as { data: string }[];
      return rows.map((r) => this.parseRow(r.data)).filter((r): r is SopRule => r !== null);
    } catch (err) {
      console.log('[SopCacheManager] Failed to load from SQLite cache, using built-in rules:', err);
      return [];
    }
  }

  /**
   * 从本地缓存加载指定模块的规则（懒加载用）
   */
  loadByDomain(module: string): SopRule[] {
    if (!this.db) return [];
    try {
      const rows = this.db.prepare('SELECT data FROM sop_rules WHERE domain = ?').all(module) as { data: string }[];
      return rows.map((r) => this.parseRow(r.data)).filter((r): r is SopRule => r !== null);
    } catch {
      return [];
    }
  }

  /**
   * 持久化规则到本地 SQLite（事务写入）
   */
  persist(rules: SopRule[]): void {
    if (!this.db) return;
    const insert = this.db.prepare(
      'INSERT OR REPLACE INTO sop_rules (id, domain, action, data) VALUES (?, ?, ?, ?)',
    );
    const tx = this.db.transaction((items: SopRule[]) => {
      for (const rule of items) {
        insert.run(rule.id, rule.domain, rule.action, this.serializeRule(rule));
      }
    });
    tx(rules);
  }

  private serializeRule(rule: SopRule): string {
    if (!this.encryption) return JSON.stringify(rule);
    try {
      const { SopSigner } = require('../security/sop-signer') as typeof import('../security/sop-signer');
      const encrypted = SopSigner.encryptRules([rule], this.encryption.machineFingerprint, this.encryption.userId);
      return JSON.stringify(encrypted);
    } catch {
      return JSON.stringify(rule);
    }
  }

  private parseRow(data: string): SopRule | null {
    try {
      const parsed: unknown = JSON.parse(data);
      if (SopSqliteStore.isEncryptedData(parsed) && this.encryption) {
        try {
          const { SopSigner } = require('../security/sop-signer') as typeof import('../security/sop-signer');
          const decrypted = SopSigner.decryptRules(parsed, this.encryption.machineFingerprint, this.encryption.userId);
          return decrypted[0] ?? null;
        } catch {
          // Decryption failed — data may be corrupted or key mismatch; skip
          return null;
        }
      }
      return parsed as SopRule;
    } catch {
      return null;
    }
  }

  private static isEncryptedData(obj: unknown): obj is EncryptedData {
    return (
      typeof obj === 'object' &&
      obj !== null &&
      'iv' in obj &&
      'encrypted' in obj &&
      'authTag' in obj &&
      'algorithm' in obj
    );
  }

  /**
   * 清空规则表
   */
  clear(): void {
    if (!this.db) return;
    try {
      this.db.exec('DELETE FROM sop_rules');
    } catch {
      // 忽略清理错误
    }
  }
}
