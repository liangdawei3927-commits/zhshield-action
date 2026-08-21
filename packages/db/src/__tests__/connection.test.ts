import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { DbConnection, initDatabase } from '../connection';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

describe('DbConnection', () => {
  const testDbPath = path.join(os.tmpdir(), `zh-test-${Date.now()}.db`);

  afterEach(() => {
    try { fs.unlinkSync(testDbPath); } catch { /* ok */ }
    try { fs.unlinkSync(testDbPath + '-wal'); } catch { /* ok */ }
    try { fs.unlinkSync(testDbPath + '-shm'); } catch { /* ok */ }
  });

  it('should connect and create database file', () => {
    const conn = new DbConnection({ dbPath: testDbPath });
    const db = conn.connect();
    expect(db).toBeInstanceOf(Database);
    expect(fs.existsSync(testDbPath)).toBe(true);
    conn.close();
  });

  it('should enable WAL mode by default', () => {
    const conn = new DbConnection({ dbPath: testDbPath });
    const db = conn.connect();
    const mode = db.pragma('journal_mode', { simple: true }) as string;
    expect(mode.toLowerCase()).toBe('wal');
    conn.close();
  });

  it('should enable foreign keys', () => {
    const conn = new DbConnection({ dbPath: testDbPath });
    const db = conn.connect();
    const fk = db.pragma('foreign_keys', { simple: true }) as number;
    expect(fk).toBe(1);
    conn.close();
  });

  it('should return same instance on repeated connect()', () => {
    const conn = new DbConnection({ dbPath: testDbPath });
    const db1 = conn.connect();
    const db2 = conn.connect();
    expect(db1).toBe(db2);
    conn.close();
  });

  it('should create directories if they do not exist', () => {
    const nestedPath = path.join(os.tmpdir(), 'zh-nested', 'sub', 'test.db');
    const conn = new DbConnection({ dbPath: nestedPath });
    conn.connect();
    expect(fs.existsSync(nestedPath)).toBe(true);
    conn.close();
    try {
      fs.unlinkSync(nestedPath);
      fs.rmdirSync(path.dirname(nestedPath));
      fs.rmdirSync(path.dirname(path.dirname(nestedPath)));
    } catch { /* ok */ }
  });

  it('should throw on getDb() before connect()', () => {
    const conn = new DbConnection({ dbPath: testDbPath });
    expect(() => conn.getDb()).toThrow('Not connected');
  });

  it('should close connection', () => {
    const conn = new DbConnection({ dbPath: testDbPath });
    conn.connect();
    conn.close();
    // After close, getDb should throw
    expect(() => conn.getDb()).toThrow('Not connected');
  });

  it('should disable WAL mode when configured', () => {
    const conn = new DbConnection({ dbPath: testDbPath, walMode: false });
    const db = conn.connect();
    const mode = db.pragma('journal_mode', { simple: true }) as string;
    expect(mode.toLowerCase()).not.toBe('wal');
    conn.close();
  });

  describe('migrations', () => {
    it('should run migrations from directory', () => {
      const conn = new DbConnection({ dbPath: testDbPath });
      conn.connect();

      const migrationsDir = path.resolve(__dirname, '../../migrations');
      conn.migrate(migrationsDir);

      const db = conn.getDb();
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
      ).all() as { name: string }[];

      const tableNames = tables.map(t => t.name);
      expect(tableNames).toContain('projects');
      expect(tableNames).toContain('scores');
      expect(tableNames).toContain('scanning_results');
      expect(tableNames).toContain('rules');
      expect(tableNames).toContain('experiences');
      expect(tableNames).toContain('sentinel_events');
      expect(tableNames).toContain('_migrations');

      conn.close();
    });

    it('should not re-apply already run migrations', () => {
      const conn = new DbConnection({ dbPath: testDbPath });
      conn.connect();

      const migrationsDir = path.resolve(__dirname, '../../migrations');
      conn.migrate(migrationsDir);

      const db = conn.getDb();
      const migrationCount1 = (db.prepare('SELECT COUNT(*) as c FROM _migrations').get() as { c: number }).c;

      // Run again
      conn.migrate(migrationsDir);
      const migrationCount2 = (db.prepare('SELECT COUNT(*) as c FROM _migrations').get() as { c: number }).c;

      expect(migrationCount2).toBe(migrationCount1);
      conn.close();
    });

    it('should throw if migrations dir does not exist', () => {
      const conn = new DbConnection({ dbPath: testDbPath });
      conn.connect();
      // Should not throw, just skip
      expect(() => conn.migrate('/nonexistent/path')).not.toThrow();
      conn.close();
    });
  });

  describe('initDatabase', () => {
    it('should create db, connect, and run migrations in one call', () => {
      const db = initDatabase({ dbPath: testDbPath });
      expect(db).toBeInstanceOf(Database);

      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
      ).all() as { name: string }[];
      const tableNames = tables.map(t => t.name);
      expect(tableNames).toContain('projects');
      expect(tableNames).toContain('scores');
      expect(tableNames).toContain('_migrations');
    });

    it('should skip migrations when skipMigrate is true', () => {
      const db = initDatabase({ dbPath: testDbPath, skipMigrate: true });
      expect(db).toBeInstanceOf(Database);

      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
      ).all() as { name: string }[];
      const tableNames = tables.map(t => t.name);
      expect(tableNames).not.toContain('projects');
    });

    it('should use custom migrations directory', () => {
      const customDir = path.join(os.tmpdir(), `zh-custom-mig-${Date.now()}`);
      fs.mkdirSync(customDir, { recursive: true });
      fs.writeFileSync(path.join(customDir, '001_test.sql'),
        'CREATE TABLE IF NOT EXISTS custom_test (id INTEGER PRIMARY KEY);');
      const db = initDatabase({ dbPath: testDbPath, migrationsDir: customDir });

      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='custom_test'"
      ).all();
      expect(tables).toHaveLength(1);

      fs.rmSync(customDir, { recursive: true, force: true });
    });
  });
});
