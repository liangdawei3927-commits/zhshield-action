import { DbConnection } from '@zh/db';
import type { SopRule } from '../_meta/sop-types';

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

  constructor(private readonly dbPath: string) {}

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
      return rows.map((r) => JSON.parse(r.data)) as SopRule[];
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
      return rows.map((r) => JSON.parse(r.data)) as SopRule[];
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
        insert.run(rule.id, rule.domain, rule.action, JSON.stringify(rule));
      }
    });
    tx(rules);
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
