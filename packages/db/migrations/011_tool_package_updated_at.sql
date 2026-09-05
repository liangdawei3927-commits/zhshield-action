-- 011 · tool_package 补充 updated_at 列
-- 依据：queries.saveToolPackage / softDeleteToolPackage upsert 需刷新 updated_at，
--       而 010 的 tool_package 表只有 created_at（rule_content 两者皆有，属 010 遗漏）。
-- 纪律：不修改已应用的 010（_migrations 已记录，改文件不会对已迁移库生效），
--       新增 011 保证新建库与已迁移库都具备该列。

ALTER TABLE tool_package ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP;