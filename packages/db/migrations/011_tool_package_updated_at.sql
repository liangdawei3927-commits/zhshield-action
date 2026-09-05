-- 011 · tool_package 补充 updated_at 列
-- 依据：queries.saveToolPackage / softDeleteToolPackage upsert 需刷新 updated_at，
--       而 010 的 tool_package 表只有 created_at（rule_content 两者皆有，属 010 遗漏）。
-- 根因修正：SQLite 禁止对已有数据的表 ADD COLUMN 使用非常量默认值
--       （CURRENT_TIMESTAMP → "Cannot add a column with non-constant default"），
--       原写法只对空表成功，非空真实库（tool_package 已有行）必然失败，导致
--       迁移每次重试失败。改为「无默认 ADD COLUMN + SQL 内回填」：
--       - 既有行回填 updated_at = created_at（首次写入即有意义的时间戳）
--       - 新行的 updated_at 由 queries.saveToolPackage 显式写入 CURRENT_TIMESTAMP
--         （与 ON CONFLICT 分支一致，010 后 tool_package 无列默认值）
-- 纪律：不修改已应用的 010/其他 0xx（_migrations 已记录，改文件不会对已迁移库生效）；
--       011 在本版本中从未在非空库成功应用，修改后对未应用库生效、对已应用库无影响。

ALTER TABLE tool_package ADD COLUMN updated_at DATETIME;
UPDATE tool_package SET updated_at = created_at;