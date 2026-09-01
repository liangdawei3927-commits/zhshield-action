// @zh/db — 数据库层
export const VERSION = '0.1.0';

export { DbConnection, initDatabase } from './connection';
export type { DbConfig } from './connection';

export * from './types';
export * from './queries';
export * from './batch';
