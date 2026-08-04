# RETRACTED: OMP extension 加载调查（错误结论）

> ⚠️ **本调查结论已撤回**（Oracle 2026-08-04 系统验证推翻）。保留为 postmortem。

## 撤回原因

原调查声称"OMP 17.2.x extension 加载竞态缺陷（--extension 随机失败、自动发现 0%）"，
**结论错误**——判据用了裸 `console.log/warn` 是否出现在 `~/.omp/logs/omp.*.log`。

Oracle 源码级验证（`/tmp/oh-my-pi`）：

1. **加载管线正常且确定性**：`loader.ts` 逐项顺序 await import → 校验 factory → await factory；
   `legacy-pi-compat.ts:2497-2520` 依次 await realpath/override/graph-hook/import。
   不存在"import 成功但随机跳过 factory"分支；异常会变成 load error。
2. **console 去向（而非加载）**：OMP 集中 logger 不 monkey-patch console。裸 `console.warn`
   走 fd2/stderr；macOS 交互 TUI 在 `ui.start()` 调用 `suppressTerminalStderr()`，
   仅当 stdout/stderr 同 TTY 时用 `dup2` 把 fd2 重定向到 PID 日志（`stderr-guard.ts:95-131`），
   TUI stop 恢复。**TUI 启动前的 warn 留在终端（不进日志）；TUI 持有期间才进日志**——时序决定，非概率加载。
3. **决定性副作用证据**：load marker（default export 写文件）——`--extension` 3/3、
   自动发现 2/2 全部执行。extension 一直正常加载。

## 真正的集成问题（已修复/待跟踪）

- **codeagent launcher 空 worker_id**（`runners/omp.py`）：非 manager 时 identity 的
  `worker_id` 曾恒空 → 插件 `readIdentityFile` 拒绝 → activate 永不进入（现场 64/64 为空）。
  **已修复**：缺省非空 `worker`；调用方应显式设 `OMP_WORKER_ID`。
- **插件 seen-before-send**（`src/index.ts` poll）：原 `seen.add` 在 `sendMessage` 前——
  send 抛错时消息被永久去重。**已修复**：send 成功后再去重，失败保留重试。

## 教训

- 判"extension 未加载"必须用**副作用判据**（marker/文件写入），不能看 console 日志。
- extension 日志应使用 `pi.logger.*`（稳定进 OMP 结构化日志）；裸 console 仅作 TUI/stderr 诊断。

## 原证据（存档）

- --extension 17.2.4 1/3、17.2.5 3/4 有 `[mailbox] identity` 日志（实为 fd2 重定向时序）
- 自动发现多次"0 输出"（实为 TUI 前 console 未进日志）
- marker require bug（ESM `require` ReferenceError 被吞）——已修
