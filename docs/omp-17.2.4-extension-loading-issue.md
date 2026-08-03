# OMP 17.2.4：extension 加载竞态（--extension 约 33% 成功率，自动发现 0%）

## 环境

- OMP 17.2.4（homebrew `/opt/homebrew/Cellar/omp/17.2.4`）
- macOS 27（darwin 27.0.0, arm64）
- 无 profile（OMP_PROFILE/PI_PROFILE 未设）

## 现象

自定义 extension（`omp.extensions: ["./src/index.ts"]`，default export 读 `OMP_MAILBOX_IDENTITY_FILE` env，有身份则 activate 并 watcher 监听 inbox）加载不稳定：

1. **自动发现全部不加载**（extension 的 default export 从未执行——default 开头写 `/tmp/omp-mb-load-<pid>.json` marker，从未出现）：
   - `~/.omp/agent/extensions/*.ts`（含独立 probe-extension.ts，`console.log("[probe-ext] LOADED")` 在日志中无输出）
   - `~/.omp/agent/config.yml#extensions` 数组
   - `~/.omp/agent/settings.json#extensions`（`omp config list` 确认 `[internal].extensions` 有值）
   - `omp config set extensions <json>`（官方命令，值确认写入）
   - `omp plugin install`（node_modules 真实目录，`omp plugin list`/`doctor` 显示 enabled:true / 9 ok）
   - `omp plugin link <dir>`（symlink）
2. **显式 `--extension <path>` 概率性加载**：交互会话 3 次中 1 次成功（日志出现 `[mailbox] identity: wake-e2e/wake1` + 消息触发 📬 通知 + agent 处理 + finalize 全通）；同命令同配置其余 2 次无任何加载痕迹。此前单次也成功过一次（共 2/4）。

## 复现

```sh
# 需要 omp-mailbox-plugin（github:comicchang/omp-mailbox-plugin）
# identity 文件
mkdir -p ~/.omp/mailbox-identity
echo '{"session_id":"s1","worker_id":"w1"}' > ~/.omp/mailbox-identity/test.json
# 交互会话（重复 3+ 次观察非确定性）
env SWARM_SESSION_ID=s1 OMP_WORKER_ID=w1 OMP_MAILBOX_SESSION_ID=s1 OMP_MAILBOX_AGENT_ID=w1 \
  OMP_MAILBOX_IDENTITY_FILE=~/.omp/mailbox-identity/test.json \
  omp --extension /path/to/omp-mailbox-plugin/src/index.ts --model <model> '等第一条消息'
# 成功时日志：~/.omp/logs/omp.<pid>.log 含 "[mailbox] identity: s1/w1"
# 失败时：无任何 [mailbox] 痕迹，且 default export 的 marker /tmp/omp-mb-load-<pid>.json 不存在
```

## 证据

- extension 代码可独立加载：`bun -e "import('./src/index.ts')"` → default 是 function
- env 注入确认：agent 会话内 `printenv` 可见 OMP_MAILBOX_IDENTITY_FILE/SWARM_SESSION_ID 等
- probe extension（无 env 依赖，仅 console.log）在自动发现路径下也无输出 → **default export 根本未执行**（非 activate 失败）
- `--extension` 路径下 marker 与激活日志同时出现/同时缺失 → **加载管线竞态**（偶发执行 default）

## 期望

- 自动发现（extensions/、settings extensions、installed plugins）应稳定加载
- `--extension` 显式路径应确定性加载（当前 ~33%）

## 附加

- 失败时无任何加载错误日志（扩展加载错误被静默吞掉或未报告）
- `omp config list` 显示 `[internal].extensions` 有值但运行时未消费
