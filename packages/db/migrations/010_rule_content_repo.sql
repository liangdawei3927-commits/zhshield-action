-- 010 · 规则内容仓库与管理后台（05-规则内容仓库与管理后台.md §二）
-- 依据：04-架构重建蓝图/05-规则内容仓库与管理后台.md（C1 数据模型）
-- 纪律：规则/工具内容全部入库，管理员后台 CRUD + 发布 + 回滚；发布写平台 NULL 行（org_id IS NULL）。
-- H1 硬约束：rule_content.content_sha 必须 = computeRuleContentSha(SopRule)，禁止另起口径。
-- 软删语义：deprecated / disabled；不物理删历史。

-- ─── 规则本体表 ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rule_content (
  id          TEXT PRIMARY KEY,          -- 语义 ID：治理域.动作.来源.规则名（沿用现有 id 体系）
  rule_id     TEXT NOT NULL UNIQUE,      -- 稳定业务键（客户端用它识别规则）
  domain      TEXT NOT NULL,             -- guard | inspect | security | sentinel | evolve | refactor
  action      TEXT NOT NULL,             -- scan | block | alert | score | calibrate | suggest
  source      TEXT NOT NULL DEFAULT 'official',  -- official | external | community | calibrated
  name        TEXT NOT NULL,             -- 规则名（同 YAML name）
  description TEXT,                      -- 描述
  severity    TEXT NOT NULL,             -- critical | high | medium | low | info | error
  status      TEXT NOT NULL DEFAULT 'draft',  -- draft | trial | active | deprecated | disabled
  execution_mode TEXT NOT NULL DEFAULT 'async', -- sync | async | periodic | event
  tags        TEXT NOT NULL DEFAULT '[]',       -- JSON 数组
  applicable_engines TEXT NOT NULL DEFAULT '[]',-- JSON 数组
  languages   TEXT NOT NULL DEFAULT '[]',       -- JSON 数组（画像匹配维度）
  frameworks  TEXT NOT NULL DEFAULT '[]',       -- JSON 数组
  tool_id     TEXT,                             -- 绑定的工具（semgrep/trivy/eslint/dep-cruiser）
  tool_version TEXT,                            -- 绑定的工具包版本（sha256 前缀）
  content     TEXT NOT NULL,             -- 规则本体（SopRule 稳定子集的规范化序列化，见 H1）
  content_sha TEXT NOT NULL,             -- computeRuleContentSha(SopRule)（硬约束 H1，禁另起口径）
  version     TEXT NOT NULL,             -- 当前有效版本号（变更时递增）
  created_by  TEXT,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_by  TEXT,
  updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_rule_content_domain ON rule_content(domain);
CREATE INDEX IF NOT EXISTS idx_rule_content_status ON rule_content(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_rule_content_rule_id ON rule_content(rule_id);

-- ─── 规则版本历史表 ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rule_content_version (
  id          TEXT PRIMARY KEY,
  rule_id     TEXT NOT NULL,             -- 关联 rule_content.rule_id
  version     TEXT NOT NULL,             -- 该版本的版本号
  content_sha TEXT NOT NULL,
  content     TEXT NOT NULL,             -- 该版本规则本体（快照）
  status_at_release TEXT NOT NULL,       -- 发布时的规则状态
  released_by TEXT,
  released_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  changes     TEXT,                      -- 变更说明（管理员填写）
  UNIQUE(rule_id, version)
);

-- ─── 工具包注册表 ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tool_package (
  id           TEXT PRIMARY KEY,
  tool_id      TEXT NOT NULL,            -- semgrep | trivy | eslint | dep-cruiser | (未来扩展)
  version      TEXT NOT NULL,            -- 工具规则包版本（由内容 hash 派生）
  sha256       TEXT NOT NULL,            -- 完整包 sha256（客户端校验）
  files_json   TEXT NOT NULL,            -- [{filename, content}] 完整规则包内容
  languages    TEXT NOT NULL DEFAULT '[]', -- 适用语言（画像裁剪）
  frameworks   TEXT NOT NULL DEFAULT '[]',
  status       TEXT NOT NULL DEFAULT 'active',  -- active | deprecated | disabled
  description  TEXT,
  created_by   TEXT,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tool_id)                        -- 当前生效版本
);

-- ─── 工具包版本历史表 ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tool_package_version (
  id          TEXT PRIMARY KEY,
  tool_id     TEXT NOT NULL,
  version     TEXT NOT NULL,
  sha256      TEXT NOT NULL,
  files_json  TEXT NOT NULL,             -- 该版本完整规则包快照
  languages   TEXT NOT NULL DEFAULT '[]',
  frameworks  TEXT NOT NULL DEFAULT '[]',
  released_by TEXT,
  released_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  changes     TEXT,                      -- 变更说明（管理员填写）
  UNIQUE(tool_id, version)
);

-- ─── 内容操作审计 ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS content_audit_log (
  id         TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,             -- rule | tool
  entity_id  TEXT NOT NULL,              -- rule_id / tool_id
  action     TEXT NOT NULL,              -- create | update | delete | publish | rollback | status_change
  detail     TEXT,                       -- before/after 摘要
  operator   TEXT NOT NULL,              -- 管理员身份
  operated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 常用查询索引
CREATE INDEX IF NOT EXISTS idx_rule_content_version_rule ON rule_content_version(rule_id);
CREATE INDEX IF NOT EXISTS idx_tool_package_version_tool ON tool_package_version(tool_id);
CREATE INDEX IF NOT EXISTS idx_content_audit_entity ON content_audit_log(entity_type, entity_id);