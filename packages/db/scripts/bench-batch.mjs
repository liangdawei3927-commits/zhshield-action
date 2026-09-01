// 批量落库基准：单行循环 vs 单事务批量 prepared insert（10,000 行）
// 用法：node packages/db/scripts/bench-batch.mjs
import Database from 'better-sqlite3';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(__dirname, '../migrations');

const N = 10000;

function createDb(dbPath) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    db.exec(fs.readFileSync(path.join(migrationsDir, file), 'utf-8'));
  }
  return db;
}

function makeRows(n) {
  return Array.from({ length: n }, (_, i) => ({
    projectId: 'proj-bench',
    overall: 60 + (i % 40),
    grade: 'B',
    dimensions: '{}',
    trend: 'improving',
  }));
}

function benchSingleLoop(db, rows) {
  const insert = db.prepare(
    'INSERT INTO scores (project_id, overall, grade, dimensions, trend) VALUES (?, ?, ?, ?, ?)',
  );
  const start = process.hrtime.bigint();
  for (const r of rows) insert.run(r.projectId, r.overall, r.grade, r.dimensions, r.trend);
  return Number(process.hrtime.bigint() - start) / 1e6;
}

function benchBatch(db, rows) {
  const insert = db.prepare(
    'INSERT INTO scores (project_id, overall, grade, dimensions, trend) VALUES (?, ?, ?, ?, ?)',
  );
  const tx = db.transaction((rs) => {
    for (const r of rs) insert.run(r.projectId, r.overall, r.grade, r.dimensions, r.trend);
  });
  const start = process.hrtime.bigint();
  tx(rows);
  return Number(process.hrtime.bigint() - start) / 1e6;
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zh-bench-'));
const singleDbPath = path.join(tmpDir, 'bench-single.db');
const batchDbPath = path.join(tmpDir, 'bench-batch.db');

try {
  const rows = makeRows(N);

  // 单行循环（当前方案）
  const db1 = createDb(singleDbPath);
  const singleMs = benchSingleLoop(db1, rows);
  const singleCount = db1.prepare('SELECT COUNT(*) as c FROM scores').get().c;
  db1.close();

  // 单事务批量
  const db2 = createDb(batchDbPath);
  const batchMs = benchBatch(db2, rows);
  const batchCount = db2.prepare('SELECT COUNT(*) as c FROM scores').get().c;
  db2.close();

  const speedup = singleMs / batchMs;
  const pct = (1 - batchMs / singleMs) * 100;

  console.log(`行数: ${N}`);
  console.log(`单行循环 (当前方案): ${singleMs.toFixed(2)} ms  (落库 ${singleCount} 行)`);
  console.log(`单事务批量:          ${batchMs.toFixed(2)} ms  (落库 ${batchCount} 行)`);
  console.log(`加速比: ${speedup.toFixed(2)}x`);
  console.log(`耗时下降: ${pct.toFixed(1)}%`);
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
