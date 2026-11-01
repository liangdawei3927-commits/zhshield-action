/**
 * 域快照 schema 已下沉 `@zh/pipeline`（《07》A6）：CLI 与桌面端必须共用同一份
 * 落盘格式与读取口径。本文件保留原有相对导入路径（桌面端十余处 import 不必
 * 一次性改动），以类型整体转出，避免手抄字段清单造成第二份真源。
 */
export type * from '@zh/pipeline';
