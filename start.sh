#!/usr/bin/env bash
# ============================================================
#  智汇码盾 (ZhiYan CodeShield) 终端启动脚本
#  用法: ./start.sh [命令]
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── 颜色 ──────────────────────────────────────────
RED='\033[0;31m' GREEN='\033[0;32m' YELLOW='\033[1;33m'
BLUE='\033[0;34m' CYAN='\033[0;36m' BOLD='\033[1m' NC='\033[0m'

banner() {
  echo -e "${CYAN}"
  echo "  ╔═══════════════════════════════════════════╗"
  echo "  ║       智汇码盾  CodeShield v0.1.0          ║"
  echo "  ║       Terminal Launcher                    ║"
  echo "  ╚═══════════════════════════════════════════╝"
  echo -e "${NC}"
}

ok()   { echo -e "${GREEN}✓${NC} $*"; }
warn() { echo -e "${YELLOW}!${NC} $*"; }
err()  { echo -e "${RED}✗${NC} $*"; }
info() { echo -e "${BLUE}▶${NC} $*"; }

# ── 环境检查 ──────────────────────────────────────
check_env() {
  if ! command -v node &>/dev/null; then
    err "未找到 Node.js，请安装 Node >= 20"
    exit 1
  fi
  local v; v=$(node -v | sed 's/v//' | cut -d. -f1)
  [[ "$v" -lt 20 ]] && { err "Node.js 版本过低 ($(node -v))，需要 >= 20"; exit 1; }
  ok "Node.js $(node -v)"

  if ! command -v pnpm &>/dev/null; then
    warn "未找到 pnpm，正在安装..."
    npm install -g pnpm
  fi
  ok "pnpm $(pnpm -v)"
}

# ── 命令实现 ──────────────────────────────────────
# init：装依赖后立即跑 verify —— 首次安装即验证环境可复现，
# 避免「node_modules 损坏 → 手动重装 → 再手动验证」的循环。
cmd_init() {
  banner
  check_env
  info "安装依赖..."
  pnpm install
  ok "依赖安装完成"
  info "自动运行一键环境验证 (install→build→typecheck→test)..."
  bash scripts/verify-env.sh
  ok "首次环境验证通过"
}
cmd_build()     { banner; check_env; info "构建全部包..."; pnpm build; ok "构建完成"; }
cmd_dev()       { banner; check_env; info "启动桌面端开发（先由 turbo 构建依赖包）..."; pnpm exec turbo run dev --filter=@zh/desktop; }
cmd_lint()      { banner; check_env; info "代码检查..."; pnpm lint; }
cmd_test()      { banner; check_env; info "运行测试..."; pnpm test; }
cmd_clean()     { banner; info "清理构建产物..."; pnpm clean; ok "清理完成"; }
cmd_verify()    { banner; check_env; info "一键环境验证 (install → build → typecheck → test)..."; bash scripts/verify-env.sh; ok "环境验证完成"; }
cmd_verify_fix(){ banner; check_env; info "干净重建 + 环境验证..."; bash scripts/verify-env.sh --fix; ok "干净重建验证完成"; }

cmd_dev_desktop() { banner; check_env; info "启动桌面端开发（先由 turbo 构建依赖包）..."; pnpm exec turbo run dev --filter=@zh/desktop; }
cmd_dev_server()  { banner; check_env; info "启动后端服务开发 (Ctrl+C 停止)..."; pnpm --filter @zh/server dev; }

cmd_build_mac() { banner; check_env; info "构建依赖包..."; pnpm exec turbo run build --filter=@zh/desktop^...; info "构建桌面端 macOS DMG..."; pnpm --filter @zh/desktop build:mac; ok "桌面端构建完成 → packages/desktop/../../../build-output/（仓库外）"; }

cmd_check()           { banner; check_env; info "运行智汇码盾自检..."; pnpm check; }
cmd_check_staged()    { banner; check_env; info "检查暂存区..."; pnpm check:staged; }
cmd_check_refactor()  { banner; check_env; info "仅重构检查..."; pnpm check:refactor; }
cmd_hooks()           { banner; check_env; info "安装 Git hooks..."; pnpm hooks:install; ok "hooks 安装完成"; }

cmd_test_watch()    { banner; check_env; info "测试监听模式 (Ctrl+C 停止)..."; pnpm --filter @zh/server test:watch; }
cmd_test_coverage() { banner; check_env; info "测试 + 覆盖率..."; pnpm turbo run test -- --coverage; ok "覆盖率报告已生成"; }

cmd_status() {
  banner
  echo -e "${BOLD}项目信息:${NC}"
  echo "  名称:     智汇码盾 (zhiyan-codeshield)"
  echo "  包管理:   pnpm $(pnpm -v 2>/dev/null || echo 'N/A')"
  echo "  Node:     $(node -v 2>/dev/null || echo 'N/A')"
  echo "  Git 分支: $(git branch --show-current 2>/dev/null || echo 'N/A')"
  echo ""
  echo -e "${BOLD}子包列表:${NC}"
  echo "  kernel      核心治理引擎 (SOP 规则集)"
  echo "  server      后端服务 (NestJS)"
  echo "  desktop     桌面端 (Electron + React)"
  echo "  cli         命令行工具 (zhshield)"
  echo "  pipeline    流水线编排"
  echo "  guard       自动化守护门禁"
  echo "  inspect     智能巡检与优化"
  echo "  security    安全防护"
  echo "  scoring     健康评分"
  echo "  evolve      进化系统"
  echo "  sentinel    哨兵监控"
  echo "  refactor    智能重构"
  echo "  reporter    报告生成"
  echo "  db          数据库"
  echo "  shared      共享工具"
}

cmd_help() {
  banner
  echo -e "用法: ${CYAN}./start.sh <命令>${NC}"
  echo ""
  echo -e "${BOLD}初始化:${NC}"
  echo "  init               安装依赖"
  echo "  hooks              安装 Git pre-commit hooks"
  echo ""
  echo -e "${BOLD}开发:${NC}"
  echo "  dev                全量开发模式 (Turborepo)"
  echo "  dev:desktop        仅启动桌面端 (Electron)"
  echo "  dev:server         仅启动后端服务 (NestJS)"
  echo ""
  echo -e "${BOLD}构建:${NC}"
  echo "  build              构建所有包"
  echo "  build:mac          构建桌面端 macOS DMG"
  echo ""
  echo -e "${BOLD}测试 & 检查:${NC}"
  echo "  test               运行全量测试"
  echo "  test:watch         测试监听模式"
  echo "  test:coverage      测试 + 覆盖率"
  echo "  lint               代码检查"
  echo "  check              智汇码盾自检 (全部引擎)"
  echo "  check:staged       仅检查暂存区文件"
  echo "  check:refactor     仅重构检查"
  echo ""
  echo -e "${BOLD}其他:${NC}"
  echo "  clean              清理构建产物"
  echo "  verify             一键环境验证 (install→build→typecheck→test)"
  echo "  verify:fix         彻底重建 node_modules 后验证（node_modules 损坏时用）"
  echo "  status             项目状态"
  echo "  help               本帮助"
  echo ""
  echo -e "示例:"
  echo -e "  ${CYAN}./start.sh init${NC}              # 首次安装"
  echo -e "  ${CYAN}./start.sh dev${NC}               # 日常开发"
  echo -e "  ${CYAN}./start.sh dev:desktop${NC}       # 只开发桌面端"
  echo -e "  ${CYAN}./start.sh build:mac${NC}         # 打包 DMG"
}

# ── 入口 ──────────────────────────────────────────
case "${1:-help}" in
  init)             cmd_init ;;
  build)            cmd_build ;;
  dev)              cmd_dev ;;
  dev:desktop)      cmd_dev_desktop ;;
  dev:server)       cmd_dev_server ;;
  build:mac)        cmd_build_mac ;;
  lint)             cmd_lint ;;
  test)             cmd_test ;;
  test:watch)       cmd_test_watch ;;
  test:coverage)    cmd_test_coverage ;;
  check)            cmd_check ;;
  check:staged)     cmd_check_staged ;;
  check:refactor)   cmd_check_refactor ;;
  hooks)            cmd_hooks ;;
  clean)            cmd_clean ;;
  verify)           cmd_verify ;;
  verify:fix)       cmd_verify_fix ;;
  status)           cmd_status ;;
  help|-h|--help)   cmd_help ;;
  *)                err "未知命令: $1"; echo; cmd_help; exit 1 ;;
esac
