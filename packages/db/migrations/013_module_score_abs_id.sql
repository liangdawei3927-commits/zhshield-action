-- 013: 模块评分的 scores.project_id 从相对路径回填为绝对路径
--
-- 背景
--   模块级评分（monorepo 每个子包一张卡）曾把画像给出的相对路径直接当 project_id 落库，
--   例如 'packages/ui'、'packages/api-sdk'。相对路径不是全局唯一标识：
--   任意两个 monorepo 只要有同名子包，就会读写同一行记录，历史曲线互相污染。
--   代码侧已改为写入绝对路径（scoring/src/module-score.ts 的 ModuleScoreInput.id），
--   本迁移负责把历史记录回填成同一口径，使旧数据在新读取口径下仍可命中。
--
-- 归属判据（确定性，非启发式）
--   一次 pipeline 会在同一秒内为「被扫项目本身 + 它的全部子模块」各落一条分，
--   因此一条相对路径记录所在的那一秒，若存在**唯一**一个绝对路径记录，
--   该记录的项目根就是这条模块记录的归属项目。
--   - 找不到任何绝对记录 → 无主，保持原样（读取侧已拒绝相对键，自然失效，不会串库）
--   - 找到多个不同候选 → 有歧义，保持原样（宁可不归属，也不猜）
--   判据由 HAVING COUNT(DISTINCT p.project_id) = 1 强制，歧义行不进入更新集。
--
-- 说明
--   绝对路径判定用 '/%'，面向 POSIX（本产品当前只发 macOS）。Windows 盘符形式需另行处理。

-- 先算出「可唯一归属」的映射，避免在 UPDATE 中边改边读导致自引用
CREATE TEMP TABLE _module_score_owner AS
SELECT
  m.id AS score_id,
  MIN(p.project_id) AS owner_root
FROM scores m
JOIN scores p
  ON p.created_at = m.created_at
 AND p.project_id LIKE '/%'
WHERE m.project_id NOT LIKE '/%'
GROUP BY m.id
HAVING COUNT(DISTINCT p.project_id) = 1;

UPDATE scores
SET project_id = (
  SELECT o.owner_root || '/' || scores.project_id
  FROM _module_score_owner o
  WHERE o.score_id = scores.id
)
WHERE id IN (SELECT score_id FROM _module_score_owner);

DROP TABLE _module_score_owner;

CREATE INDEX IF NOT EXISTS idx_scores_project_created
  ON scores(project_id, created_at, id);
