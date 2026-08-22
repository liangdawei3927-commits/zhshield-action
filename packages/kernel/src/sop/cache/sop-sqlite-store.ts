import { DbConnection } from '@zh/db';
import type { SopRule } from '../_meta/sop-types';
import { SmartCompressor } from '../smart-compressor';
import type { CompressedData } from '../smart-compressor';

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

/** data 列中压缩负载的信封结构（SmartCompressor 产物 + 标记位） */
interface CompressedEnvelope extends CompressedData {
  __zhCompressed: true;
}

function isCompressedEnvelope(value: unknown): value is CompressedEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record['__zhCompressed'] === true &&
    typeof record['strategy'] === 'string' &&
    typeof record['data'] === 'string'
  );
}

/** 超过该长度的序列化负载才值得压缩（与 json-minify 策略 minSize 对齐） */
const COMPRESS_MIN_LENGTH = 100;

/**
 * SopSqliteStore — 本地规则 SQLite 存储
 *
 * 负责 sop_rules 表的建表、查询、事务持久化与清空。
 * 大负载经 SmartCompressor 压缩为信封存储，读取时透明解压；历史明文行保持兼容。
 */
export class SopSqliteStore {
  private db: Database | null = null;
  private readonly compressor?: SmartCompressor;

  constructor(private readonly dbPath: string, options?: { compressor?: SmartCompressor }) {
    this.compressor = options?.compressor;
  }

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
      return rows.map((r) => this.decodeRule(r.data));
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
      return rows.map((r) => this.decodeRule(r.data));
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
        insert.run(rule.id, rule.domain, rule.action, this.encodeRule(rule));
      }
    });
    tx(rules);
  }

  /**
   * 按 ID 删除规则（维护裁剪用，事务执行）
   */
  remove(ids: string[]): void {
    if (!this.db || ids.length === 0) return;
    const del = this.db.prepare('DELETE FROM sop_rules WHERE id = ?');
    const tx = this.db.transaction((items: string[]) => {
      for (const id of items) del.run(id);
    });
    tx(ids);
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

  /** 序列化规则：负载超过阈值时经 SmartCompressor 压缩为信封 */
  private encodeRule(rule: SopRule): string {
    const raw = JSON.stringify(rule);
    if (!this.compressor || raw.length < COMPRESS_MIN_LENGTH) return raw;
    const envelope: CompressedEnvelope = { ...this.compressor.compress(raw), __zhCompressed: true };
    return JSON.stringify(envelope);
  }

  /** 解析行数据：信封则透明解压，明文直接返回（兼容历史行） */
  private decodeRule(data: string): SopRule {
    const parsed: unknown = JSON.parse(data);
    if (!isCompressedEnvelope(parsed)) return parsed as SopRule;
    if (!this.compressor) {
      throw new Error(`Compressed SOP rule found but no compressor configured: ${parsed['strategy'] ?? 'unknown'}`);
    }
    return JSON.parse(this.compressor.decompress(parsed)) as SopRule;
  }
}
