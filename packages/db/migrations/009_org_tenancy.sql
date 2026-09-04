-- 009 · M3 轻量 Org 多租户（自研建模）
-- 依据：M3 开发规格 §三（04-架构重建蓝图/05-开发规格/M3-多租户云端规则服务.md）
-- 前提：tianyin schema 无 Organization/Tenant/Workspace 模型可参考（09-04 实机核对），
--       仅复用 @zh/db 既有迁移执行器；不引 Prisma/ORM。
-- 纪律：org_id NULL = 平台默认（全局兜底）；所有租户读取必须显式带 org_id 过滤。

CREATE TABLE IF NOT EXISTS orgs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS org_members (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('owner', 'admin', 'member')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id, user_id)
);

-- 既有 projects 表挂到组织（可空 = 平台级项目，保持旧行为兼容）
ALTER TABLE projects ADD COLUMN org_id TEXT REFERENCES orgs(id);

-- 规则注册表：按租户的启用/版本快照。org_id NULL = 平台默认；
-- 同一 rule_id 组织行覆盖平台行（合并语义在查询层实现）。
CREATE TABLE IF NOT EXISTS rule_scope (
  id TEXT PRIMARY KEY,
  rule_id TEXT NOT NULL,
  org_id TEXT REFERENCES orgs(id),
  version TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
  content_sha TEXT,
  source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('manual', 'calibrated')),
  published_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id, rule_id)
);

-- 画像快照：客户端 T0 注册时提交，服务端 T1 resolve 的依据
CREATE TABLE IF NOT EXISTS project_features (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  framework TEXT,
  language TEXT,
  features_json TEXT NOT NULL DEFAULT '[]',
  schema_version INTEGER NOT NULL DEFAULT 1,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(project_id)
);

CREATE INDEX IF NOT EXISTS idx_rule_scope_org ON rule_scope(org_id);
CREATE INDEX IF NOT EXISTS idx_org_members_user ON org_members(user_id);
CREATE INDEX IF NOT EXISTS idx_projects_org ON projects(org_id);
