#!/bin/bash
#
# NormCode 上游同步脚本
# 用于定期同步 microsoft/vscode 的更新到本地仓库
#
# 使用方法:
#   ./scripts/sync-upstream.sh [选项]
#
# 选项:
#   --rebase    使用 rebase 方式合并（默认）
#   --merge     使用 merge 方式合并
#   --dry-run   仅检查更新，不执行同步
#   --help      显示帮助信息
#

set -e

# ============================================================================
# 配置
# ============================================================================
UPSTREAM_REMOTE="upstream"
UPSTREAM_URL="https://github.com/microsoft/vscode.git"
ORIGIN_REMOTE="origin"
MAIN_BRANCH="main"
FEATURE_BRANCH="cursor-core"
MERGE_STRATEGY="rebase"  # 默认使用 rebase
DRY_RUN=false

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# ============================================================================
# 工具函数
# ============================================================================
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

show_help() {
    echo "NormCode 上游同步脚本"
    echo ""
    echo "使用方法: ./scripts/sync-upstream.sh [选项]"
    echo ""
    echo "选项:"
    echo "  --rebase    使用 rebase 方式合并到功能分支（默认）"
    echo "  --merge     使用 merge 方式合并到功能分支"
    echo "  --dry-run   仅检查更新，不执行同步"
    echo "  --help      显示此帮助信息"
    echo ""
    echo "工作流程:"
    echo "  1. 检查工作区是否干净"
    echo "  2. 获取上游 (microsoft/vscode) 最新代码"
    echo "  3. 将上游更新合并到 main 分支"
    echo "  4. 将 main 分支更新合并到 cursor-core 分支"
    echo "  5. 推送更新到 origin"
    echo ""
    echo "示例:"
    echo "  ./scripts/sync-upstream.sh              # 使用 rebase 同步"
    echo "  ./scripts/sync-upstream.sh --merge      # 使用 merge 同步"
    echo "  ./scripts/sync-upstream.sh --dry-run    # 仅检查更新"
}

# ============================================================================
# 解析参数
# ============================================================================
while [[ $# -gt 0 ]]; do
    case $1 in
        --rebase)
            MERGE_STRATEGY="rebase"
            shift
            ;;
        --merge)
            MERGE_STRATEGY="merge"
            shift
            ;;
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        --help|-h)
            show_help
            exit 0
            ;;
        *)
            log_error "未知选项: $1"
            show_help
            exit 1
            ;;
    esac
done

# ============================================================================
# 主流程
# ============================================================================
main() {
    echo ""
    echo "=========================================="
    echo "   NormCode 上游同步脚本"
    echo "=========================================="
    echo ""

    # 记录当前分支
    CURRENT_BRANCH=$(git branch --show-current)
    log_info "当前分支: $CURRENT_BRANCH"
    log_info "合并策略: $MERGE_STRATEGY"
    echo ""

    # Step 1: 检查工作区状态
    log_info "Step 1: 检查工作区状态..."
    if [[ -n $(git status --porcelain) ]]; then
        log_error "工作区有未提交的更改，请先提交或 stash"
        echo ""
        git status --short
        exit 1
    fi
    log_success "工作区干净"
    echo ""

    # Step 2: 确保 upstream remote 存在
    log_info "Step 2: 检查 upstream remote..."
    if ! git remote get-url $UPSTREAM_REMOTE &>/dev/null; then
        log_warning "upstream remote 不存在，正在添加..."
        git remote add $UPSTREAM_REMOTE $UPSTREAM_URL
        log_success "已添加 upstream: $UPSTREAM_URL"
    else
        log_success "upstream remote 已配置"
    fi
    echo ""

    # Step 3: 获取上游更新
    log_info "Step 3: 获取上游最新代码..."
    git fetch $UPSTREAM_REMOTE --no-tags
    log_success "已获取上游更新"
    echo ""

    # Step 4: 检查更新数量
    log_info "Step 4: 检查更新..."
    UPSTREAM_COMMITS=$(git rev-list --count $MAIN_BRANCH..$UPSTREAM_REMOTE/$MAIN_BRANCH 2>/dev/null || echo "0")

    if [[ "$UPSTREAM_COMMITS" == "0" ]]; then
        log_success "main 分支已是最新，无需同步"

        if [[ "$DRY_RUN" == true ]]; then
            exit 0
        fi
    else
        log_info "上游有 $UPSTREAM_COMMITS 个新提交"

        # 显示最近的几个提交
        echo ""
        log_info "最近的上游提交:"
        git log --oneline $MAIN_BRANCH..$UPSTREAM_REMOTE/$MAIN_BRANCH | head -10
        echo ""
    fi

    if [[ "$DRY_RUN" == true ]]; then
        log_info "[DRY-RUN] 仅检查模式，不执行实际同步"
        exit 0
    fi

    # Step 5: 同步 main 分支
    log_info "Step 5: 同步 main 分支..."
    git checkout $MAIN_BRANCH
    git merge $UPSTREAM_REMOTE/$MAIN_BRANCH --no-edit
    log_success "main 分支已更新"
    echo ""

    # Step 6: 同步功能分支
    log_info "Step 6: 同步 $FEATURE_BRANCH 分支..."
    git checkout $FEATURE_BRANCH

    if [[ "$MERGE_STRATEGY" == "rebase" ]]; then
        log_info "使用 rebase 策略..."

        # 尝试 rebase
        if git rebase $MAIN_BRANCH; then
            log_success "Rebase 成功"
        else
            log_error "Rebase 过程中出现冲突!"
            echo ""
            log_warning "请手动解决冲突:"
            echo "  1. 编辑冲突文件"
            echo "  2. git add <resolved-files>"
            echo "  3. git rebase --continue"
            echo ""
            echo "或者放弃 rebase:"
            echo "  git rebase --abort"
            exit 1
        fi
    else
        log_info "使用 merge 策略..."

        if git merge $MAIN_BRANCH --no-edit; then
            log_success "Merge 成功"
        else
            log_error "Merge 过程中出现冲突!"
            echo ""
            log_warning "请手动解决冲突:"
            echo "  1. 编辑冲突文件"
            echo "  2. git add <resolved-files>"
            echo "  3. git commit"
            exit 1
        fi
    fi
    echo ""

    # Step 7: 推送更新
    log_info "Step 7: 推送更新到 origin..."

    # 推送 main
    log_info "推送 main 分支..."
    git push $ORIGIN_REMOTE $MAIN_BRANCH

    # 推送 feature branch
    log_info "推送 $FEATURE_BRANCH 分支..."
    if [[ "$MERGE_STRATEGY" == "rebase" ]]; then
        git push $ORIGIN_REMOTE $FEATURE_BRANCH --force-with-lease
    else
        git push $ORIGIN_REMOTE $FEATURE_BRANCH
    fi

    log_success "已推送所有更新"
    echo ""

    # Step 8: 回到原分支
    log_info "Step 8: 恢复到原分支..."
    git checkout $CURRENT_BRANCH
    log_success "已切换回 $CURRENT_BRANCH"
    echo ""

    # 完成
    echo "=========================================="
    echo -e "   ${GREEN}同步完成!${NC}"
    echo "=========================================="
    echo ""
    log_info "同步摘要:"
    echo "  - 上游提交数: $UPSTREAM_COMMITS"
    echo "  - 合并策略: $MERGE_STRATEGY"
    echo "  - main 分支: 已更新并推送"
    echo "  - $FEATURE_BRANCH 分支: 已更新并推送"
    echo ""
}

# 执行主函数
main
