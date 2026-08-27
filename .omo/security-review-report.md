# 终审报告 — zhiyan-codeshield 安全审查（/security-review）

> 触发：P2 路径穿越修复（149→31）验证后，按"生产工程学长久考虑"对仓库做长期安全审计。
> 方法：3 并行猎手（surface / auth-injection / runtime）+ 2 PoC 工程师（复现 + 独立证伪）。
> 裁决：**PASS WITH FINDINGS**（P2 修复经验证真实有效；新发现 2 个真实漏洞 + 1 个防御纵深缺口）。

## 1. 裁决

**PASS WITH FINDINGS**

- P2 八包路径穿越修复：验证通过（test/lint/build 全绿，guard dry-run 0 失败）。
- 发布代码路径穿越：118→0（真实源码条目全部收敛）。
- 新发现需跟进：A（HIGH 任意写）、C（LOW–MEDIUM 任意读）、B（防御纵深缺口）。

## 2. 发现（按可利用性校准）

| # | 位置 | 类型 | 严重度 | PoC 裁定 | 证据 |
|---|------|------|--------|----------|------|
| **A** | `packages/kernel/src/sop/sync/tool-rule-sync.ts` `extractRules`（`path.join(targetDir, record.filename)`，约 L282） | 任意文件**写**（CWE-22/434） | **HIGH** | 两 PoC 一致 Reproduced | 真实调用 `new ToolRuleSync([]).extractRules(payload, targetDir)` 把文件写到了 targetDir 之外。`filename` 来自远程下载 JSON，**零校验**；哈希校验在写盘之后且只 walk `localDir`，逃逸文件不被计入哈希，攻击者同时控制下载端与版本端哈希 → 写盘"干净"通过 |
| **C** | `packages/fingerprint/src/detectors/manifest-detector.ts:57` `expandWorkspaceGlobs` + `fs-utils.ts:105` `readText` | 任意文件**读**（CWE-22 信息泄露） | **LOW–MEDIUM** | 两 PoC 一致 Reproduced | 真实调用 `ManifestDetector.detect('/tmp/zt_repo')`，workspace 模式 `../zt_escape_dir` 被原样 push，`readText` 读到了 projectRoot 之外的文件。需攻击者能控制被扫仓库的 workspace 清单；仅读、无写 |
| **B** | `packages/kernel/src/backup/zip-snapshot.ts:125` `restoreFromZipArchive`（`path.join(targetDir, entry.relativePath)`） | zip-slip 任意**写**（CWE-22） | **NOT EXPLOITABLE / 防御纵深缺口** | 降级：PoC-A Falsified，PoC-B Reproduced → 采信 PoC-A | `openZipArchive` 用 yauzl，其 `validateFileName` 在打开 zip 时即拒绝任何含 `..` 段的条目名（`invalid relative path`）。manifest 的 `relativePath` 同时用于条目查找与写路径，二者必须同名 → 含 `..` 的条目无法被打开/匹配。故 `../` 向量当前**不可利用**；但应用层**无任何路径收敛**，防御完全寄托于 yauzl |

### 分歧裁定（B）
PoC-B 报 "reproduced" 但其构建方式疑似绕过或未真实走 yauzl 打开路径；PoC-A 给出权威证据：用真实 `restoreFromZipArchive` + yauzl 打开含 `../` 条目的 zip 直接抛 `invalid relative path`，写盘从未发生。以"真实库的真实打开行为"为准，B 降级为非可利用 + 防御纵深缺口。

## 3. 残留风险（长期）

- **safeJoin 为词法检查，不解析符号链接**（runtime 猎手确认）：扫描不可信仓库时，仓内 symlink 指向仓外，`safeJoin` 词法层无法捕获。建议对收敛目录做 `fs.realpath` 二次校验或至少文档化。
- **234 处 raw `path.join`/`path.resolve`** 仍散布于非测试源码（pipeline/inspect adapters 等）。多为字面量/非不可信段，已被 semgrep allowlist 覆盖非发布项；发布代码路径已通过 P2 收敛（118→0）。
- 149→31 分析结论不变（发布代码路径穿越 0 残留）。

## 4. 修复与护栏（本次实施）

按"从工程学长久考虑"批准的三层方案执行：

- **Layer 1 — 修代码**（沿用 `@zh/shared` 的 `safeJoin`/`PathTraversalError`，不引入新范式）：
  - A：`extractRules` 写盘前 `safeJoin(targetDir, record.filename)`，捕获 `PathTraversalError` 则跳过该越界条目（不写盘到 targetDir 之外）。
  - C：`expandWorkspaceGlobs` 对非 glob / glob 两处 `path.join` 改用 `safeJoin`，越界 pattern 直接丢弃。
  - B：`restoreFromZipArchive` 写盘前 `safeJoin(targetDir, entry.relativePath)`，捕获 `PathTraversalError` 则 `failed++` 并跳过（防御纵深，不依赖 yauzl）。
  - 各包新增回归测试（path-traversal-hardening.test.ts）。
- **Layer 2 — 堵预防失控**：
  - 加固 `packages/kernel/assets/semgrep/path-traversal.yml`：原仅匹配 `path.join`/`path.resolve`，新增 `join(...)`/`resolve(...)` 以覆盖解构导入写法（A/C 正是 `path.join`，但未来重构为解构写法时仍会被拦）。
  - 按 `semgrep-redos.yml` 镜像新增 SOP 规则 `packages/kernel/src/sop/inspect/scan/security/path-traversal.yml`，接入 inspect 引擎（report-only WARNING），使路径穿越回归在 inspection 扫描中被标出。
- **Layer 3 — 架构残留（symlink）**：后续项（建议 `fs.realpath` 二次校验或文档化），不在本次范围。

## 5. 建议（按优先级）

1. **[HIGH] 修 A**：已完成（safeJoin + 跳过越界条目）。
2. **[MEDIUM] 修 C**：已完成（safeJoin 收敛 workspace pattern）。
3. **[防御纵深] 修 B**：已完成（safeJoin 收敛 relativePath）。
4. **[架构]**：评估 `safeJoin` 增加 realpath 校验以覆盖 symlink 逃逸。
