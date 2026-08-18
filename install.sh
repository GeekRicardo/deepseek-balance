#!/usr/bin/env bash
# =============================================================================
# dsh-balance 一键安装脚本（macOS / Linux / Windows Git Bash）
#
# 包只在 GitHub、不发 npm，因此本脚本直接把 github 依赖写进 profile 的
# package.json（dependencies + dsh.profile.bundles），再 pnpm install 拉取。
# 下次启动 DSH 时 profile boot 会读取包内 cordis.patch.yml 自动挂载插件行。
#
# 用法：
#   curl -fsSL https://raw.githubusercontent.com/GeekRicardo/dsh-balance/main/install.sh | bash
#
#   或下载后本地运行：bash install.sh [--dry-run] [--restart]
#
#   --dry-run   只打印将要执行的操作，不写任何文件。
#   --restart   装完后尝试重启 DSH web（pm2 托管时自动，否则提示手动）。
#   -h/--help   打印本帮助。
#
# 环境变量（均可省略）：DSH_HOME（默认 ~/.dsh）
# =============================================================================
set -euo pipefail

for arg in "$@"; do
  if [ "$arg" = "-h" ] || [ "$arg" = "--help" ]; then
    cat <<'EOF'
dsh-balance 一键安装脚本

用法：
  curl -fsSL https://raw.githubusercontent.com/GeekRicardo/dsh-balance/main/install.sh | bash
  或：bash install.sh [--dry-run] [--restart]

  --dry-run    只打印将要执行的操作，不写任何文件
  --restart    装完后尝试重启 DSH web（pm2 托管时自动，否则提示手动）

环境变量（可省略）：DSH_HOME（默认 ~/.dsh）
EOF
    exit 0
  fi
done

DSH_HOME="${DSH_HOME:-${HOME:-${USERPROFILE:-}}/.dsh}"
PROFILE_DIR="$DSH_HOME/profiles/web"
PKG_JSON="$PROFILE_DIR/package.json"
PKG="dsh-balance"
GH_DEP="github:GeekRicardo/dsh-balance"

DRY_RUN=false
RESTART=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --restart) RESTART=true ;;
    -h|--help) : ;;
    *) echo "未知参数: ${arg}（用 -h 查看用法）" >&2; exit 2 ;;
  esac
done

say()  { printf '\033[32m[install]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[warn]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || die "未找到 node（DSH 需要 Node.js ≥ 20）"
command -v pnpm >/dev/null 2>&1 || die "未找到 pnpm"
[ -d "$PROFILE_DIR" ] || die "找不到 profile 目录：${PROFILE_DIR}（请先安装并运行过一次 dsh web）"
[ -f "$PKG_JSON" ] || die "找不到 ${PKG_JSON}"

if [ "$DRY_RUN" = true ]; then
  say "[dry-run] 步骤 1：在 ${PKG_JSON} 写入 dependencies[\"${PKG}\"]=\"${GH_DEP}\""
  say "[dry-run] 步骤 2：在 dsh.profile.bundles 追加 \"${PKG}\""
  say "[dry-run] 步骤 3：cd ${PROFILE_DIR} && pnpm install"
  say "[dry-run] 步骤 4：校验 dsh.profile.bundles 含 ${PKG}"
  [ "$RESTART" = true ] && say "[dry-run] 步骤 5：重启 DSH web（pm2 托管时自动，否则提示手动）" || say "[dry-run] 步骤 5：提示用户重启 DSH"
  exit 0
fi

say "目标 profile：${PROFILE_DIR}"

# 步骤 1+2：幂等写 dependencies + bundles
UPDATE_RESULT="$(node -e '
const fs = require("fs");
const p = process.argv[1];
const dep = process.argv[2];
const pkg = process.argv[3];
const json = JSON.parse(fs.readFileSync(p, "utf8"));
let changed = false;
json.dependencies = json.dependencies || {};
if (json.dependencies[pkg] !== dep) {
  json.dependencies[pkg] = dep;
  changed = true;
}
json.dsh = json.dsh || {};
json.dsh.profile = json.dsh.profile || {};
json.dsh.profile.bundles = Array.isArray(json.dsh.profile.bundles) ? json.dsh.profile.bundles : [];
if (!json.dsh.profile.bundles.includes(pkg)) {
  json.dsh.profile.bundles.push(pkg);
  changed = true;
}
if (changed) {
  fs.writeFileSync(p, JSON.stringify(json, null, 2) + "\n");
  console.log("updated");
} else {
  console.log("unchanged");
}
' "$PKG_JSON" "$GH_DEP" "$PKG")"
[ "$UPDATE_RESULT" = "updated" ] \
  && say "已写入 dependencies + dsh.profile.bundles（${PKG} = ${GH_DEP}）" \
  || say "dependencies + bundles 已就绪，跳过"

# 步骤 3：安装依赖
say "执行 pnpm install（拉取 GitHub 包，可能耗时）..."
( cd "$PROFILE_DIR" && pnpm install )

# 步骤 4：校验 bundles 已注册
if ! node -e '
  const fs = require("fs");
  const p = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const bundles = p.dsh?.profile?.bundles ?? [];
  process.exit(bundles.includes(process.argv[2]) ? 0 : 1);
' "$PKG_JSON" "$PKG"; then
  die "dsh-balance 未出现在 dsh.profile.bundles 中，挂载未注册，请检查 pnpm install 输出。"
fi
say "bundle 已注册：dsh.profile.bundles 包含 ${PKG}（下次启动自动挂载）"

say "安装完成：${PKG}"

# 步骤 5：重启提示
if [ "$RESTART" = true ]; then
  if command -v pm2 >/dev/null 2>&1 && pm2 list 2>/dev/null | grep -q "dsh"; then
    say "检测到 pm2 托管的 dsh，重启 dsh-web..."
    pm2 restart dsh-web || warn "pm2 restart 失败，请手动重启 DSH"
  else
    warn "未检测到 pm2 托管的 dsh 进程，无法自动重启。"
    warn "请手动重启：结束 dsh web 进程后重新运行 dsh web。"
  fi
else
  say "下一步：重启 DSH web 并硬刷新（Cmd/Ctrl+Shift+R）使插件生效。"
  say "pm2 托管：pm2 restart dsh-web；否则：结束 dsh web 进程后重新运行 dsh web。"
fi
