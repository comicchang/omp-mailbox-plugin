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

OMP 17.2.x 的 extension 加载有竞态缺陷（见「已知问题」），触发式唤醒不可靠时，
**prompt 引导 agent 定期 `codeagent mailbox peek` 轮询**——100% 可用（不依赖 extension 管线）。

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

## 已知问题（OMP 17.2.x extension 加载竞态）

- **症状**：`omp` 裸启动/`--extension` 时 extension **随机不加载**（插件未激活、无 `[mailbox] identity` 日志、inbox 新消息不唤醒）；`omp plugin doctor` 全 OK 但运行时不生效
- **根因**：OMP extension 加载管线（loadLegacyPiModule/withHostGuard，Bun import）非确定性 + 错误静默吞掉（OMP_DEBUG 也无日志）。web_search 有同类公开报告（2026-05/06）
- **证据**：最小 10 行零依赖 extension `--extension`×5 全失败；自动发现（extensions/、config.yml#extensions、settings.json#extensions、plugin install/link）0%；17.2.4→17.2.5 有改善（1/3→3/4）未根除
- **缓解**：
  - 用 `omp-mailbox` 启动包装（`--extension`，dotai setup 生成）
  - 或 prompt 引导 agent 轮询 mailbox peek（100% 可靠）
  - issue 证据包：`docs/omp-17.2.4-extension-loading-issue.md`（可提交 can1357/oh-my-pi）

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

- 加载 marker：plugin default export 开头写 `/tmp/omp-mb-load-<pid>.json`（区分「未加载」vs「加载失败」——注意 ESM 下勿用 require）
- 激活日志：`[mailbox] identity: <sid>/<wid>`（activate 的 console.warn → OMP 日志）

## License

MIT
