// queries.ts —— 查询函数按领域拆分后的聚合出口（薄桶文件）。
// 原 956 行单文件已按领域拆至以下同级模块，本文件仅做 re-export，
// 保持 `export * from './queries'` 的导出面与拆分前完全一致，导入方无需任何改动。
//
// 领域划分：
// - queries-projects.ts    项目 / 评分 / 扫描结果 / 技术债
// - queries-rules.ts       规则状态 / 校准经验
// - queries-sentinel.ts    哨兵事件
// - queries-org.ts         组织多租户 / 规则租户快照 / 项目画像
// - queries-content.ts     规则内容仓库（迁移 010）
// - queries-lifecycle.ts   项目软删清理 / 孤儿治理（含 PROJECT_DATA_TABLES 共享常量）

export * from './queries-projects';
export * from './queries-rules';
export * from './queries-sentinel';
export * from './queries-org';
export * from './queries-content';
export * from './queries-lifecycle';
