/**
 * SOP 管理写路径的公共基类（sop-admin.repository.base.ts）
 *
 * ## 为什么单独一层，而不塞进 SopContentRepository
 *
 * `SopContentRepository` 的对外契约是**只读 + 降级**：DB 不可用返回 `null`，
 * 由调用方决定怎么兜底，绝不 throw（那会把「库没起来」变成「服务起不来」）。
 * 写路径的语义恰好相反：DB 不可用必须**立刻失败**，否则管理端会以为写成功了。
 *
 * 两种语义放在同一个类里，后来者迟早会在读路径里顺手用 `requireDb()`，
 * 把一条「优雅降级」悄悄变成「抛异常」。所以这里只把**写路径专用的两个
 * 前置检查**收成一层，读仓库的契约原样保留。
 *
 * ## 收的是什么
 *
 * `SopRuleAdminRepository` 与 `SopToolAdminRepository` 此前各自逐字重写：
 *
 * ```ts
 * private requireDb() { const db = this.tryReadyDb(); if (!db) throw new AdminError('数据库不可用','unavailable'); return db; }
 * private requireConn() { this.requireDb(); const conn = this.dbConn; if (!conn) throw ...; return conn; }
 * ```
 *
 * 这两段没有任何域差异（差异在 `requireRule` / `requireTool` 的实体类型与文案上，
 * 那是各自保留的）。收进基类后，新增第三个写仓库不必再抄一遍。
 */
import type { DbConnection } from '@zh/db';
import { AdminError } from './sop-content-admin.shared';
import { SopContentRepository } from './sop-content.repository';

/**
 * 管理写路径基类：在只读仓库之上补「DB 必须可用」的硬前置。
 *
 * 子类只声明各自的实体校验（`requireRule` / `requireTool`…）与写方法。
 */
export abstract class SopAdminRepositoryBase extends SopContentRepository {
  /** DB 不可用直接抛 unavailable（503），不静默降级 */
  protected requireDb(): ReturnType<DbConnection['getDb']> {
    const db = this.tryReadyDb();
    if (!db) throw new AdminError('数据库不可用', 'unavailable');
    return db;
  }

  /** requireDb() 成功后 dbConn 必已就绪；返回连接供 transaction 使用 */
  protected requireConn(): DbConnection {
    this.requireDb();
    const conn = this.dbConn;
    if (!conn) throw new AdminError('数据库不可用', 'unavailable');
    return conn;
  }
}
