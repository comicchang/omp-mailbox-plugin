# omp-mailbox-plugin

OMP extension for session-based direct-inbox worker-to-worker messaging via
[codeagent-py](https://github.com/comicchang/codeagent-py) swarm/mailbox protocol.
No relay daemon —跨主机通信走 SSH wire protocol（Mode B Remote Transport）；
同一主机共享 mailbox root（Mode A Shared FS）亦可。

**检测**：`fs.watch`（zero-latency, rename+create）+ 30s interval fallback + `agent_end` 立即检查。
**唤醒**：inbox 新消息 → `pi.sendMessage({ triggerTurn: true, deliverAs: "nextTurn" })`。
**激活**：deferred —— 读 launcher 注入的身份 env（`OMP_MAILBOX_IDENTITY_FILE`）。

```
Worker A:  codeagent swarm direct --session <id> --from A --to B ...  → <root>/<session>/B/inbox/{msg_id}.json
                              ↓ (SSH wire / 本地写入)
Worker B:  fs.watch → mailbox peek → sendMessage(triggerTurn) → read → finalize (auto-claim)
```

## 前置

Thin notification adapter——所有 mailbox 操作委托给 codeagent-py 的 `mailbox`/`codeagent` CLI：

```bash
uv tool install git+https://github.com/comicchang/codeagent-py.git@v0.2.5
# 安装 'codeagent' + 'mailbox' + 'codeagent-remote-exec' 等入口
```

激活时做 capability check：`codeagent --version` ≥ `MAILBOX_MIN_VERSION`（0.1.0）；失败显式报错，不静默降级。

## 安装

### dotai setup（推荐）

`dotai` 的 components.json 已注册 `omp-mailbox-plugin`（`default_enabled: true`），
setup 的 OMP 插件阶段自动安装（bun install github:comicchang/omp-mailbox-plugin）+ 配置：

```bash
./scripts/setup.py work-offline-nogui   # 或对应环境
```

setup 额外执行 `ensure_omp_mailbox_extension()`：
1. `omp config set extensions <plugin-path>` —— OMP 修复自动加载后生效
2. 生成 `~/.local/bin/omp-mailbox` 启动包装（`exec omp --extension <path>`）—— 当前 OMP 版本可用入口

### 手动

```bash
cd ~/.omp/plugins && bun add github:comicchang/omp-mailbox-plugin
# 或
omp plugin install github:comicchang/omp-mailbox-plugin
```

## 配置

| Env | Required | 说明 |
|---|---|---|
| `OMP_MAILBOX_IDENTITY_FILE` | 是（Worker） | 身份 JSON 路径 `{session_id, worker_id}`——launcher 注入（codeagent OMPRunner 写 per-run token 文件） |
| `OMP_MAILBOX_SESSION_ID` / `OMP_MAILBOX_AGENT_ID` | 是 | 会话/agent 标识（Manager 会话无身份 → 不激活） |
| `MAILBOX_ROOT` | 否 | mailbox root（默认 `~/.local/share/codeagent/mailbox`） |
| `MAILBOX_CLI` | 否 | mailbox CLI（默认 PATH 的 `mailbox`） |

无 `OMP_MAILBOX_IDENTITY_FILE` → Manager 会话，插件不激活（静默 return）。

## 唤醒机制

1. `fs.watch` 监听 `<root>/<session>/<agent>/inbox`（rename/create 事件，zero-latency）
2. 30s interval fallback + `agent_end` 后立即检查
3. `mailbox peek --session <id> --agent <id>`（非消费）→ 新消息按 `msg_id` 去重（滚动集合 max 100）
4. 每条新消息 → `sendMessage({ triggerTurn: true })` → 唤醒空闲 agent

**关键纪律**：插件只通知、永不消费。agent 以 `mailbox read` 的 inbox 为准。

### 唤醒的可靠 Fallback（agent 轮询）

触发式唤醒（fs.watch → triggerTurn）依赖 OMP extension 正常运行；作为补充，
**prompt 引导 agent 定期 `codeagent mailbox peek` 轮询**同样可用（不依赖唤醒通知）。

## 协议

原子 JSON 文件（tmp → os.replace），消费时校验：

```json
{"session_id":"s1","from":"mgr","to":"w1","subject":"...","body":"...","kind":"TASK",
 "msg_id":"mgr_20260803T000000Z_abc123","created_at":"...","trace_id":"...","causation_id":"..."}
```

**必需字段**：session_id, from, to, subject, body, kind, msg_id, created_at。
**Kinds**：TASK / REPORT / PROGRESS / EVIDENCE / QUESTION / RESPONSE / NOTICE。
**两阶段消费**：`mailbox read`（inbox→processing）→ 处理 → `mailbox finalize`（→archive）；`release` 退回 inbox；`recover-stale` 恢复过期 claim（300s lease）。
跨主机：`codeagent mailbox ... --host <alias>`；高级 IPC：`codeagent swarm ...`。

## 诊断（加载与激活判据）

**注意**：extension 的裸 `console.log/warn` **不是可靠判据**——OMP 集中 logger 不
monkey-patch console；裸 console 走 stdout/stderr，macOS 交互 TUI 下 fd2 仅在其
持有终端期间被重定向到 PID 日志（stderr-guard），时序决定是否进日志文件。

**可靠三层判据**（Oracle 验证）：
1. **load marker**：extension default export 的副作用（如写文件）——确认模块加载 + factory 执行
2. **有效 identity**：`OMP_MAILBOX_IDENTITY_FILE` 指向的 JSON `session_id`/`worker_id` **均非空**
   （空 worker_id → 插件 readIdentityFile 拒绝 → activate 永不进入）
3. **activation / 真实 wake**：激活后向 inbox 发唯一 msg_id，验证会话出现
   `customType:"omp-mailbox"` 通知 + agent 实际处理（不依赖日志 grep）

插件日志应使用 `pi.logger.*`（稳定进 OMP 结构化日志）；裸 console 仅作 stderr/TUI 诊断。

## 已知问题（激活前置条件）

- **launcher identity 必须非空**：`codeagent run --backend omp` 注入的 identity 若
  `worker_id` 为空（环境无 `OMP_WORKER_ID`），插件不会 activate。已修复（缺省 "worker"）；
  调用方应显式设 `OMP_WORKER_ID` 匹配 inbox 目录。
- **激活时序**：default export 执行 ≠ activate 完成（activate 异步 poll identity + 注册
  watcher/handlers）。消息可能早于 watcher 就绪——agent 轮询 `mailbox peek` 兜底。

## 开发

```bash
bun install
bun run typecheck    # tsc --noEmit — 0 errors
bun test             # wake tests（2 pass）
```

CI（codeagent-py repo）：

```bash
./scripts/check-plugin-types.sh              # 默认 ../omp-mailbox-plugin
./scripts/check-plugin-types.sh /path/to/plugin
```

## 诊断

- **加载判据**：extension default export 的副作用（marker 文件等）——勿用裸 console 日志（见「诊断」三层判据）
- **激活判据**：有效非空 identity + activation marker / 真实 wake（`customType:"omp-mailbox"` 通知 + agent 处理）

## License

MIT
