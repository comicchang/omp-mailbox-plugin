#!/usr/bin/env bash
# omp-mailbox-plugin 独立安装脚本（不依赖 dotai）
#
# 适用于：其他 Agent / 没有 dotai 环境的人，在任意 macOS/Linux 主机上
# 安装 codeagent CLI + omp-mailbox-plugin + OMP 扩展配置。
#
# 用法：
#   bash <(curl -fsSL https://raw.githubusercontent.com/comicchang/omp-mailbox-plugin/main/scripts/install.sh)
#   或
#   curl -fsSL .../install.sh -o install.sh && bash install.sh
#
# 可配置环境变量：
#   CODEAGENT_REF=v0.2.5         codeagent 安装 ref
#   MAILBOX_MIN_OK=1             跳过 codeagent 安装（已装则验证）
#   OMP_EXTENSION_SKIP=1         跳过 OMP extension 配置（仅装 CLI+plugin）
set -euo pipefail

CODEAGENT_REF="${CODEAGENT_REF:-v0.2.5}"
REPO="https://github.com/comicchang/omp-mailbox-plugin"
LOG_PREFIX="[omp-mailbox]"

say()  { printf '%s %s\n' "$LOG_PREFIX" "$*"; }
die()  { printf '%s ERROR: %s\n' "$LOG_PREFIX" "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# ── 0. 平台检测 ────────────────────────────────────────────────────────
OS="$(uname -s)"
case "$OS" in
  Darwin|Linux) ;;
  *) die "unsupported OS: $OS (macOS/Linux only)" ;;
esac
say "platform: $OS $(uname -m)"

# ── 1. 依赖检测 ────────────────────────────────────────────────────────
have uv   || die "uv not found — install first: curl -LsSf https://astral.sh/uv/install.sh | sh"
have bun  || say "warn: bun not found — plugin install will use npm fallback"

# ── 2. codeagent CLI（mailbox/codeagent 入口）─────────────────────────
if have codeagent && codeagent --version >/dev/null 2>&1; then
  say "codeagent already installed: $(codeagent --version)"
else
  say "installing codeagent@${CODEAGENT_REF} via uv tool install..."
  uv tool install "git+https://github.com/comicchang/codeagent-py.git@${CODEAGENT_REF}" --force
  have codeagent || die "codeagent install failed — add ~/.local/bin to PATH"
fi

# ── 3. omp-mailbox-plugin ──────────────────────────────────────────────
# 插件目录：优先 OMP 标准插件目录（~/.omp/plugins），否则本地 ~/.local/share/dotai/omp/plugins
PLUGIN_ROOT="${OMP_PLUGIN_ROOT:-}"
if [ -z "$PLUGIN_ROOT" ]; then
  if [ -d "${HOME}/.omp/plugins" ] && [ -w "${HOME}/.omp/plugins" ]; then
    PLUGIN_ROOT="${HOME}/.omp/plugins"
  else
    PLUGIN_ROOT="${HOME}/.local/share/dotai/omp/plugins"
    mkdir -p "$PLUGIN_ROOT"
  fi
fi
say "plugin root: $PLUGIN_ROOT"

if [ -e "${PLUGIN_ROOT}/node_modules/omp-mailbox-plugin/src/index.ts" ] && [ "${FORCE:-0}" != "1" ]; then
  say "omp-mailbox-plugin already present (skipping install; FORCE=1 to reinstall)"
else
  if have bun; then
    (cd "$PLUGIN_ROOT" && bun add "github:comicchang/omp-mailbox-plugin" --force)
  elif have npm; then
    (cd "$PLUGIN_ROOT" && npm install --no-save "git+${REPO}.git")
  else
    die "need bun or npm to install plugin"
  fi
  [ -e "${PLUGIN_ROOT}/node_modules/omp-mailbox-plugin/src/index.ts" ] || die "plugin install failed"
fi
PLUGIN_ENTRY="${PLUGIN_ROOT}/node_modules/omp-mailbox-plugin/src/index.ts"

# ── 4. OMP extension 配置 ──────────────────────────────────────────────
if [ "${OMP_EXTENSION_SKIP:-0}" = "1" ]; then
  say "OMP extension config skipped (OMP_EXTENSION_SKIP=1)"
else
  if have omp; then
    say "configuring OMP extensions (omp config set extensions)..."
    omp config set extensions "[\"${PLUGIN_ENTRY}\"]" || say "warn: omp config set failed (older OMP?)"

    # omp-mailbox 启动包装（--extension 是当前 OMP 17.2.x 唯一可靠加载路径）
    WRAPPER="${HOME}/.local/bin/omp-mailbox"
    mkdir -p "$(dirname "$WRAPPER")"
    cat > "$WRAPPER" <<EOF
#!/bin/sh
# omp-mailbox — OMP 启动包装（带 omp-mailbox-plugin extension 加载）
# 由 install.sh 生成。OMP 17.2.x 的 extension 自动发现不可靠，--extension 是
# 可靠路径；OMP 修复自动加载后本包装可弃用（omp config set 已写入配置）。
exec omp --extension '${PLUGIN_ENTRY}' "\$@"
EOF
    chmod +x "$WRAPPER"
    say "wrapper generated: ${WRAPPER}"
  else
    say "omp not found — plugin installed but OMP 扩展配置跳过（安装 omp 后重跑）"
  fi
fi

# ── 5. 验证 ────────────────────────────────────────────────────────────
say "verifying..."
codeagent --version
[ -e "$PLUGIN_ENTRY" ] && say "plugin entry OK: $PLUGIN_ENTRY"
say "done. 使用：omp-mailbox（带唤醒）或 omp（无唤醒，agent 轮询）"
say "身份注入（Worker 会话）：SWARM_SESSION_ID/OMP_WORKER_ID/OMP_MAILBOX_IDENTITY_FILE 由 launcher 提供"
