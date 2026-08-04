# omp-mailbox-plugin 自动安装提示词（给 AI/Agent）

> 你是安装助手。读取本文件后，**自动执行以下安装步骤**（不要询问用户确认每一步，
> 除非遇到明确错误）。目标主机：macOS 或 Linux。

## 背景

omp-mailbox-plugin 让 OMP（oh-my-pi）agent 被跨主机 mailbox 消息唤醒
（inbox 新消息 → triggerTurn）。依赖 codeagent-py 的 mailbox CLI。
本项目不依赖 dotai——以下安装流程可独立执行。

## 安装步骤（自动执行）

### 1. 检查前置工具

```bash
command -v uv || echo "NEED_UV"    # 必需
command -v bun || echo "NO_BUN"    # 插件安装需要 bun 或 npm
command -v omp || echo "NO_OMP"    # 可选（无 omp 则只装 CLI+plugin）
```

- `NEED_UV` → 安装：`curl -LsSf https://astral.sh/uv/install.sh | sh`
- `NO_BUN` → 后续用 npm 替代

### 2. 安装 codeagent CLI（提供 mailbox/codeagent 入口）

```bash
uv tool install "git+https://github.com/comicchang/codeagent-py.git@v0.2.5" --force
codeagent --version   # 验证；PATH 缺 ~/.local/bin 时导出
```

### 3. 安装插件

```bash
PLUGIN_ROOT="${HOME}/.local/share/dotai/omp/plugins"
mkdir -p "$PLUGIN_ROOT"
cd "$PLUGIN_ROOT"
bun add "github:comicchang/omp-mailbox-plugin" --force
# 无 bun：npm install --no-save "git+https://github.com/comicchang/omp-mailbox-plugin.git"
ls node_modules/omp-mailbox-plugin/src/index.ts   # 验证
```

### 4. 配置 OMP 扩展（有 omp 时）

```bash
PLUGIN_ENTRY="${PLUGIN_ROOT}/node_modules/omp-mailbox-plugin/src/index.ts"
omp config set extensions "[\"${PLUGIN_ENTRY}\"]"   # 官方配置

# 生成 omp-mailbox 启动包装（启动便利项，可选）
mkdir -p "${HOME}/.local/bin"
cat > "${HOME}/.local/bin/omp-mailbox" <<EOF
#!/bin/sh
exec omp --extension '${PLUGIN_ENTRY}' "\$@"
EOF
chmod +x "${HOME}/.local/bin/omp-mailbox"
```

### 5. 验证

```bash
codeagent --version                       # 期望 v0.2.5
ls "${PLUGIN_ENTRY}"                      # 期望存在
# 启动测试（可选）：
# env SWARM_SESSION_ID=s1 OMP_WORKER_ID=w1 OMP_MAILBOX_SESSION_ID=s1 \
#   OMP_MAILBOX_AGENT_ID=w1 \
#   OMP_MAILBOX_IDENTITY_FILE=<(echo '{"session_id":"s1","worker_id":"w1"}') \
#   omp-mailbox "你是 w1，等待 mailbox 消息"
# 激活验证（三层判据）：① load marker 副作用 ② identity 非空 ③ 真实 wake
#   （发唯一 msg_id → 会话出现 omp-mailbox 通知 + agent 处理）
```

## 已知限制（遇到时向用户说明）

1. **激活前置**：identity 的 worker_id 必须非空（launcher 已修复缺省 `worker`；调用方应显式设 OMP_WORKER_ID）。
2. **跨主机**：发送方需 codeagent CLI + SSH 通路（`codeagent swarm direct ... --host <alias>`）。
3. 非 OMP agent（opencode/codex）不需要本插件——直接用 `codeagent mailbox`/`swarm` CLI。

## 完成标准

- codeagent CLI 可运行（v0.2.5）
- 插件 entry 存在
- （有 omp）extensions 配置写入 + omp-mailbox wrapper 生成
- 向用户报告：安装完成 + 已知限制 + 使用方式（omp-mailbox / agent 轮询）
