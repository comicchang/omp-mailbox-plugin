# omp-mailbox-plugin CHEATSHEET

OMP → codeagent mailbox 唤醒桥。快速上手/排障速查。

## 一图流

```
[发送方] codeagent swarm direct --session s1 --from A --to B ...
    ↓ (SSH wire / 本地)
<root>/s1/B/inbox/{msg_id}.json  ← fs.watch 检测
    ↓
插件: mailbox peek → sendMessage(triggerTurn:true)
    ↓
[B worker agent 被唤醒] mailbox read → 处理 → mailbox finalize
```

## 快速上手

```bash
# 1. 安装 codeagent CLI（提供 mailbox/codeagent）
uv tool install git+https://github.com/comicchang/codeagent-py.git@v0.2.5

# 2. 安装插件（dotai setup 或手动）
cd ~/.omp/plugins && bun add github:comicchang/omp-mailbox-plugin

# 3. 身份（launcher 注入；手动模拟）
mkdir -p ~/.omp/mailbox-identity
echo '{"session_id":"s1","worker_id":"w1"}' > ~/.omp/mailbox-identity/wake.json

# 4. 启动（带 extension + 身份 env；或用 dotai 生成的 omp-mailbox wrapper）
env SWARM_SESSION_ID=s1 OMP_WORKER_ID=w1 OMP_MAILBOX_SESSION_ID=s1 \
  OMP_MAILBOX_AGENT_ID=w1 \
  OMP_MAILBOX_IDENTITY_FILE=~/.omp/mailbox-identity/wake.json \
  omp-mailbox "你是 w1，等待 mailbox 消息"

# 5. 验证激活（日志出现即成功）
grep "\[mailbox\] identity" ~/.omp/logs/omp.*.log

# 6. 发消息触发唤醒
codeagent swarm direct s1 --from mgr --to w1 --kind TASK --subject hi --body hello
```

## 环境变量

| Env | 必需 | 说明 |
|---|---|---|
| `OMP_MAILBOX_IDENTITY_FILE` | Worker | 身份 JSON `{session_id, worker_id}` |
| `OMP_MAILBOX_SESSION_ID` / `OMP_MAILBOX_AGENT_ID` | Worker | 会话/agent 标识 |
| `MAILBOX_ROOT` | 否 | 默认 `~/.local/share/codeagent/mailbox` |
| `MAILBOX_CLI` | 否 | 默认 PATH `mailbox` |

无 identity env → Manager 会话，插件不激活。

## 常用命令

```bash
# 跨主机（SSH wire）
codeagent mailbox send --session s1 --from A --to B --subject t --body b --host <alias>
codeagent mailbox peek --session s1 --agent B --host <alias>
codeagent mailbox read --session s1 --agent B --owner B --host <alias>
codeagent mailbox finalize --session s1 --agent B --msg-id <id> --owner B --host <alias>

# 高级 IPC（session/roster/ACL/channel/broadcast）
codeagent swarm create-session s1 --manager mgr --members w1,w2
codeagent swarm register s1 --agent w1 --host <alias>
codeagent swarm direct s1 --from mgr --to w1 --subject t --body b
codeagent swarm status s1 --trace <trace_id>     # 按 trace 聚合链路

# outbox / dead-letter
codeagent swarm outbox pending|flush|status
codeagent swarm outbox dead|requeue|purge
```

## 排障

| 症状 | 检查 |
|---|---|
| 无 `[mailbox] identity` 日志 | extension 未加载（OMP 17.2.x 竞态）→ 用 `omp-mailbox` wrapper 或 agent 轮询 |
| 有身份日志但消息不唤醒 | 插件 watch 的 inbox 路径错（MAILBOX_ROOT/session/agent 不匹配）；或消息已被消费（peek pending=0） |
| agent 收到通知但 inbox 空 | 通知是预览，以 `mailbox read` 为准（勿信通知文本） |
| `mailbox` command not found | codeagent 未装或 PATH 缺 `~/.local/bin` |
| setup 报 dependency loop | plugins/package.json 的 specifier 非规范（应为 `github:comicchang/omp-mailbox-plugin`，勿加 #commit）→ 还原 + 删 bun.lock |

## 已知问题

OMP 17.2.x extension 加载竞态（--extension 随机失败、自动发现 0%、错误静默）——
证据包 `docs/omp-17.2.4-extension-loading-issue.md`。缓解：`omp-mailbox` wrapper / agent 轮询（100%）。

## 关键纪律

- 插件**只通知、永不消费**（peek 非消费）
- agent 以 `mailbox read` 的 inbox 为准，处理失败不 finalize（留在 processing 重试）
- 两阶段消费：read（claim）→ finalize（archive）；release 退回；recover-stale 恢复过期 claim
