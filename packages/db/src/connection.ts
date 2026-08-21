import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import crypto from 'crypto';

export interface DbConfig {
  dbPath: string;
  walMode?: boolean;
  /** 跳过自动迁移（默认 false，即自动迁移） */
  skipMigrate?: boolean;
  /** 自定义迁移目录，默认为包内 migrations/ 目录 */
  migrationsDir?: string;
  /** Optional encryption key for SQLCipher. If provided, PRAGMA key is applied after connection. */
  encryptionKey?: string;
}

export class DbConnection {
  private db: Database.Database | null = null;
  private config: DbConfig;

  constructor(config: DbConfig) {
    this.config = {
      walMode: true,
      ...config,
    };
  }

  connect(): Database.Database {
    if (this.db) return this.db;

    const dir = path.dirname(this.config.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(this.config.dbPath);

    if (this.config.encryptionKey) {
      this.db.pragma(`key = '${this.config.encryptionKey}'`);
      try {
        this.db.pragma('cipher_version');
      } catch {
        throw new Error('Invalid encryption key or database is not encrypted');
      }
    }

    if (this.config.walMode) {
      this.db.pragma('journal_mode = WAL');
    }
    this.db.pragma('foreign_keys = ON');

    return this.db;
  }

  getDb(): Database.Database {
    if (!this.db) {
      throw new Error('[DbConnection] Not connected. Call connect() first.');
    }
    return this.db;
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  migrate(migrationsDir: string): void {
    const db = this.getDb();
    this.ensureMigrationsTable(db);
    this.runPendingMigrations(db, migrationsDir);
  }

  private ensureMigrationsTable(db: Database.Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

  private runPendingMigrations(db: Database.Database, migrationsDir: string): void {
    const applied = new Set(
      db.prepare('SELECT name FROM _migrations').all().map((r) => (r as { name: string }).name),
    );

    if (!fs.existsSync(migrationsDir)) return;

    const files = this.listMigrationFiles(migrationsDir);
    const runMigration = db.transaction((sql: string, name: string) => {
      db.exec(sql);
      db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(name);
    });

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
      runMigration(sql, file);
    }
  }

  private listMigrationFiles(migrationsDir: string): string[] {
    return fs.readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
  }
}

// ─── 便捷工厂函数 ────────────────────────────────────────

/** 默认迁移目录（包内 migrations/） */
const DEFAULT_MIGRATIONS_DIR = path.resolve(__dirname, '../migrations');

/**
 * 一键初始化数据库：创建连接 + 运行迁移
 * @example
 * ```ts
 * import { initDatabase } from '@zh/db';
 * const db = initDatabase({ dbPath: './data/zhcodeshield.db' });
 * ```
 */
export function initDatabase(config: DbConfig & { dbPath: string }): Database.Database {
  const conn = new DbConnection(config);
  conn.connect();

  const migrationsDir = config.migrationsDir ?? DEFAULT_MIGRATIONS_DIR;
  if (!config.skipMigrate) {
    conn.migrate(migrationsDir);
  }

  return conn.getDb();
}

export function deriveEncryptionKey(passphrase: string, salt: string = 'zhshield-db'): string {
  return crypto.pbkdf2Sync(passphrase, salt, 100000, 32, 'sha256').toString('hex');
}
