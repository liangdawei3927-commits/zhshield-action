-- 014_score_version.sql
-- 评分算法版本落库（R5，2026-11-10）。
--
-- 为什么必须落库而不是只放内存：总分口径（技术债参考化 / 同事实去重 / 短板等级）
-- 换了一代，跨版本的趋势与归因不可直接相减。读取侧需要知道「这条记录是哪一版
-- 算出来的」；旧记录保持 NULL，表示版本未知，前端按「不可比」处理。
ALTER TABLE scores ADD COLUMN score_version INTEGER;
