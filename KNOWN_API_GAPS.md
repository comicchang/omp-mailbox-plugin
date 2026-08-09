# KNOWN API GAPS — OMP / OpenCode plugin runtime 实测差异

> 来源：真机/测试实测（2026-08）。插件 API 以**运行时实测**为准，类型声明仅供参考。

## OMP（@oh-my-pi/pi-coding-agent）

| 声明有 / 实测缺 | 影响 | 处理 |
|---|---|---|
| `ctx.isIdle()` 类型声明存在，但真实 ExtensionContext 上 undefined（部分版本） | poll 通知时若直接调用抛 TypeError | 已用 `typeof ctx?.isIdle === "function"` 守卫降级 nextTurn |
| `message_*` / `tool_execution_*` hooks 未在 pi.on 暴露（只有 session_*/turn_*/tool_call/tool_result） | 无法按 message/tool-execution 粒度上报 | 用 turn_start/turn_end + tool_call/tool_result 近似；去抖 500ms |
| `pi.ui` 不存在（UI 在 `ctx.ui`） | 用 `pi.ui` 编译报错 | 全部走 `ctx.ui` + `ctx.hasUI` 守卫 |

## OpenCode（plugin API，对照 ~/.config/opencode/plugins/tmux-agent-sidebar.js）

| 声明有 / 实测缺 | 影响 | 处理 |
|---|---|---|
| 无 `sendUserMessage` 等价物 | 无法 in-loop 注入（turn-based） | 消息排下一轮；adapter 用 `--session` warm 续接 |
| 无 UI API | 无法 setStatus/setWidget | 事件全量上报 EventStore，UI 层消费 |
| `sessionID` 在每帧顶层字段（非独立 session frame） | 原按 `{"type":"session","id"}` 提取会漏 | 任意帧捕获 `sessionID` |
| `event` hook 的 props 结构（status/sessionID/error）无类型定义 | 读取需防御 | 用 `typeof` 收窄（禁内联 cast） |
| `tool.execute.after` input 为 `{sessionID, tool, args}` | 无类型定义 | 声明本地 interface |

## 测试约束

- conftest 有 autouse guard：禁止 spawn 真实 `omp`/`opencode`（裸名或已存在绝对路径），防挂起
- 需要真后端的用例必须显式 `patch("subprocess.Popen")` 或 mock adapter/runner
- 真机验收（`oracle start` / opencode run）与单元测试分离，不跑进 pytest
