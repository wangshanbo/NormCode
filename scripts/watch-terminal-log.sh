#!/usr/bin/env bash
# 每 INTERVAL 秒读取一次终端日志文件，持续 DURATION 秒，将增量摘要写入 REPORT。
#
# Cursor 会把每个集成终端的滚动缓冲写入 ~/.cursor/projects/.../terminals/N.txt，
# 文件头 YAML 里有 pid: <shell 的 PID>。要「监听某终端进程」= 监听该 pid 对应的快照文件。
#
# 用法:
#   ./scripts/watch-terminal-log.sh --pid 25662 [REPORT]
#   ./scripts/watch-terminal-log.sh 25662 [REPORT]          # 纯数字 = 按 PID 解析
#   ./scripts/watch-terminal-log.sh [TERMINAL_LOG] [REPORT] # 直接给快照路径
#
# 搜索根目录可用环境变量: CURSOR_PROJECTS_ROOT（默认 ~/.cursor/projects）
set -euo pipefail

INTERVAL="${INTERVAL:-30}"
DURATION="${DURATION:-1800}"

CURSOR_PROJECTS_ROOT="${CURSOR_PROJECTS_ROOT:-${HOME}/.cursor/projects}"
DEFAULT_LOG="${HOME}/.cursor/projects/Users-wangshanbo-Desktop-IDE-IDE-test-demo-code-workspace/terminals/5.txt"

# 在 CURSOR_PROJECTS_ROOT 下查找 terminals/*.txt，其文件头含 pid: <pid>
resolve_log_by_pid() {
	local pid="$1"
	local matches=()
	while IFS= read -r -d '' f; do
		if head -n 20 "$f" 2>/dev/null | grep -qE "^pid:[[:space:]]*${pid}[[:space:]]*$"; then
			matches+=("$f")
		fi
	done < <(find "$CURSOR_PROJECTS_ROOT" -type f -path '*/terminals/*.txt' -print0 2>/dev/null)
	if ((${#matches[@]} == 0)); then
		echo "错误: 在 ${CURSOR_PROJECTS_ROOT} 下未找到 pid=${pid} 的终端快照文件。" >&2
		echo "请确认该终端仍打开，或改用完整路径，例如: .../terminals/5.txt" >&2
		return 1
	fi
	if ((${#matches[@]} > 1)); then
		echo "警告: 多个快照匹配 pid=${pid}，使用第一个:" >&2
		printf '  %s\n' "${matches[@]}" >&2
	fi
	printf '%s' "${matches[0]}"
}

LOG_FILE=""
REPORT="${PWD}/sentinel-terminal-watch-report.txt"

if [[ "${1:-}" == "--pid" && -n "${2:-}" ]]; then
	LOG_FILE="$(resolve_log_by_pid "$2")"
	REPORT="${3:-$REPORT}"
elif [[ "${1:-}" =~ ^[0-9]+$ ]]; then
	LOG_FILE="$(resolve_log_by_pid "$1")"
	REPORT="${2:-$REPORT}"
else
	LOG_FILE="${1:-$DEFAULT_LOG}"
	REPORT="${2:-$REPORT}"
fi

if [[ ! -f "$LOG_FILE" ]]; then
	echo "错误: 找不到日志文件: $LOG_FILE" >&2
	echo "示例: $0 --pid 25662   或   $0 /path/to/terminals/5.txt" >&2
	exit 1
fi

ITER=$(( (DURATION + INTERVAL - 1) / INTERVAL ))
last_lines=0
last_lines=$(wc -l < "$LOG_FILE" | tr -d ' ')

{
	echo "========== watch-terminal-log 开始 =========="
	echo "日志文件: $LOG_FILE"
	if head -n 8 "$LOG_FILE" | grep -qE '^pid:'; then
		echo "终端元数据: $(head -n 8 "$LOG_FILE" | grep -E '^(pid|cwd|active_command):' | head -n 3)"
	fi
	echo "报告输出: $REPORT"
	echo "间隔: ${INTERVAL}s, 总时长: ${DURATION}s, 约 ${ITER} 次采样"
	echo "起始行数: $last_lines"
	echo "=========================================="
} | tee -a "$REPORT"

for ((i = 1; i <= ITER; i++)); do
	ts="$(date '+%Y-%m-%d %H:%M:%S')"
	cur=$(wc -l < "$LOG_FILE" | tr -d ' ')

	if (( cur < last_lines )); then
		echo "[$ts] 采样 #$i: 日志行数变少（可能被截断），重置基线 $cur" | tee -a "$REPORT"
		last_lines=$cur
		sleep "$INTERVAL"
		continue
	fi

	new=$((cur - last_lines))
	chunk=""
	if (( new > 0 )); then
		chunk=$(tail -n "$new" "$LOG_FILE")
	fi
	last_lines=$cur

	errs=0 warns=0 blocked=0 lockfail=0 badlayout=0
	if [[ -n "$chunk" ]]; then
		errs=$(grep -c 'ERR\|color: #f33' <<<"$chunk" || true)
		warns=$(grep -c 'WARNING\|WARN' <<<"$chunk" || true)
		blocked=$(grep -c 'Blocked vscode-webview' <<<"$chunk" || true)
		lockfail=$(grep -c 'lock() request could not be registered' <<<"$chunk" || true)
		badlayout=$(grep -cE 'layoutBody raw=[0-9]+x-[0-9]+|layoutBody raw=[0-9]+x0 ' <<<"$chunk" || true)
	fi

	{
		echo "[$ts] #$i/$ITER | 总行=$cur | 新增行=$new | ERR≈$errs WARN≈$warns | blocked=$blocked lock=$lockfail badLayout=$badlayout"
		if (( new > 400 )); then
			echo "  (新增过多，仅展示关键词命中)"
			echo "$chunk" | grep -E 'ERR|Blocked vscode-webview|lock\(\)|layoutBody raw=.*x-|layoutBody raw=.*x0 ' | tail -n 20 || true
		elif [[ -n "$chunk" ]] && (( errs + warns + blocked + lockfail + badlayout > 0 )); then
			echo "$chunk" | grep -E 'ERR|Blocked vscode-webview|lock\(\)|layoutBody raw=.*x-|layoutBody raw=.*x0 |WARNING' | tail -n 40 || true
		fi
		echo "---"
	} | tee -a "$REPORT"

	sleep "$INTERVAL"
done

echo "$(date '+%Y-%m-%d %H:%M:%S') 采样结束。" | tee -a "$REPORT"
