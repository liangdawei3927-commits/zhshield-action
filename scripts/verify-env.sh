#!/usr/bin/env bash
# ============================================================
#  verify-env.sh — 本地一键验证脚本（复刻 CI ci.yml 关键路径）
#
#  用途：node_modules 损坏 / 环境不可复现时，一条命令回到 CI 同等状态。
#  链路：clean 依赖 → 冻结安装 → 构建(排除 desktop) → 刷新 desktop 副本 →
#        SOP 同步校验 → 全量 typecheck → 全量 test。
#  与 .github/workflows/ci.yml 的 `build-and-test` job 逐步骤对应。
#
#  用法:
#    bash scripts/verify-env.sh          # 全量验证
#    bash scripts/verify-env.sh --fix    # 先移除 node_modules 再干净安装（彻底重建）
#  别名: pnpm verify   /   ./start.sh verify
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

# ── 颜色 ──────────────────────────────────────────
RED='\033[0;31m' GREEN='\033[0;32m' YELLOW='\033[1;33m'
BLUE='\033[0;34m' CYAN='\033[0;36m' BOLD='\033[1m' NC='\033[0m'

step() { echo -e "${CYAN}▶${NC} $*"; }
ok()   { echo -e "${GREEN}✓${NC} $*"; }
warn() { echo -e "${YELLOW}!${NC} $*"; }
err()  { echo -e "${RED}✗${NC} $*"; }

# 可选 --fix：先移除可能导致损坏的 node_modules，做真正干净的安装
if [[ "${1:-}" == "--fix" ]]; then
  step "清理现有 node_modules（干净重建）..."
  rm -rf node_modules packages/*/node_modules
  ok "已移除顶层与各包 node_modules"
fi

# ── 0. 环境检查 ───────────────────────────────────
step "环境检查..."
if ! command -v node &>/dev/null; then err "未找到 Node.js (需 >= 22.13)"; exit 1; fi
if ! command -v pnpm &>/dev/null; then err "未找到 pnpm (需 >= 9, 建议 11)"; exit 1; fi
ok "node $(node -v) / pnpm $(pnpm -v)"

# ── 1. 冻结安装 ───────────────────────────────────
# 与 CI 一致：--frozen-lockfile 保证 lockfile 被严格遵守，
# node_modules 损坏时这一步会完整重建符号链接/副本。
step "pnpm install --frozen-lockfile ..."
pnpm install --frozen-lockfile
ok "依赖安装完成（遵循 pnpm-lock.yaml）"

# ── 2. 构建（排除 desktop）────────────────────────
step "构建全部包 (排除 @zh/desktop) ..."
pnpm turbo run build --filter='!@zh/desktop'
ok "构建完成"

# ── 3. 刷新 desktop injected 依赖副本 ─────────────
# CI 注释: desktop 的 injected 依赖副本在 install 时快照（早于构建，副本内无 dist），
# 删除后重装让副本带上构建产物，desktop 类型检查才能解析 @zh/* 声明。
step "刷新 desktop injected 依赖副本 ..."
rm -rf packages/desktop/node_modules
pnpm install --frozen-lockfile
ok "desktop 副本已刷新"

# ── 4. SOP 同步校验 ───────────────────────────────
step "校验 dist/sop 与 kernel 源同步 ..."
pnpm --filter zhshield-cli verify:sop
ok "SOP 同步"

# ── 5. 全量 typecheck ─────────────────────────────
step "全量 typecheck (15 packages) ..."
pnpm typecheck
ok "typecheck 通过"

# ── 6. 全量测试 ───────────────────────────────────
step "运行全部测试 (turbo run test) ..."
pnpm test
ok "测试全部通过"

echo
echo -e "${BOLD}${GREEN}═══ 环境验证通过 — 本地与 CI 处于同等可复现状态 ═══${NC}"
