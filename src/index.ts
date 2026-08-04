import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { readFileSync, existsSync, unlinkSync, writeFileSync, watch as fsWatch } from "node:fs";
import { homedir } from "node:os";

const POLL_MS = 30_000;
const IDENTITY_POLL_MS = 2_000;
const CHECK_TIMEOUT_MS = 5_000;
const MAX_DEDUP_IDS = 100;
const MAILBOX_MIN_VERSION = "0.1.0";

interface MailboxSummary {
  pending: number;
  messages: { from: string; kind: string; subject: string; msg_id: string }[];
}

export interface Config {
  sessionId: string;
  agentId: string;
  mailboxRoot: string;
  cliPath: string;
  inboxDir: string;
}

function buildConfig(sessionId: string, agentId: string): Config {
  const root = process.env.MAILBOX_ROOT ?? `${homedir()}/.local/share/codeagent/mailbox`;
  const cli = process.env.MAILBOX_CLI ?? "mailbox";
  return { sessionId, agentId, mailboxRoot: root, cliPath: cli, inboxDir: `${root}/${sessionId}/${agentId}/inbox` };
}

function versionGte(actual: string, required: string): boolean {
  const pa = actual.split(".").map(Number);
  const pr = required.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pr.length); i++) {
    const a = pa[i] ?? 0;
    const r = pr[i] ?? 0;
    if (a > r) return true;
    if (a < r) return false;
  }
  return true;
}

async function checkMailboxCli(cliPath: string): Promise<void> {
  try {
    // Try codeagent --version first (canonical package provides mailbox + codeagent)
    const proc = Bun.spawn(["codeagent", "--version"], { stdout: "pipe", stderr: "pipe", timeout: CHECK_TIMEOUT_MS });
    const out = await new Response(proc.stdout).text();
    const match = out.match(/(\d+\.\d+\.\d+)/);
    if (match && proc.exitCode === 0) {
      if (!versionGte(match[1], MAILBOX_MIN_VERSION)) {
        console.error(`[mailbox] codeagent version ${match[1]} < required ${MAILBOX_MIN_VERSION}. Please upgrade codeagent.`);
        throw new Error(`mailbox CLI version too old: ${match[1]} < ${MAILBOX_MIN_VERSION}`);
      }
      return; // version OK
    }
  } catch { /* fall through to existence check */ }

  // Fallback: verify the CLI is at least callable (e.g. 'mailbox --help' exits 0)
  try {
    const proc = Bun.spawn([cliPath, "--help"], { stdout: "pipe", stderr: "pipe", timeout: CHECK_TIMEOUT_MS });
    await proc.exited;
    if (proc.exitCode !== 0) {
      console.error(`[mailbox] CLI '${cliPath}' is not callable (exit ${proc.exitCode}). Is codeagent installed? (pipx install codeagent-py)`);
      throw new Error(`mailbox CLI not functional: ${cliPath}`);
    }
  } catch (e) {
    console.error(`[mailbox] CLI '${cliPath}' not found in PATH. Set MAILBOX_CLI or install codeagent (pipx install codeagent-py).`);
    throw new Error(`mailbox CLI not found: ${cliPath}`);
  }
}

function readIdentityFile(path: string): Config | null {
  try {
    if (!existsSync(path)) return null;
    const data = JSON.parse(readFileSync(path, "utf-8"));

    // Stale identity guard: if owner_pid is present and process is dead, skip
    const ownerPid = data.owner_pid as number | undefined;
    if (ownerPid) {
      try {
        process.kill(ownerPid, 0); // signal 0 = existence check
      } catch {
        return null; // PID no longer alive — stale identity
      }
    }

    // Nonce guard: if identity has a nonce, it must match the launcher's expected nonce
    const expectedNonce = process.env.OMP_MAILBOX_NONCE;
    if (data.nonce && expectedNonce && data.nonce !== expectedNonce) {
      return null; // nonce mismatch — identity from a different launcher
    }

    const sid = data.session_id ?? data.sessionId;
    const wid = data.worker_id ?? data.agentId ?? data.workerId;
    if (!sid || !wid) return null;
    console.warn(`[mailbox] identity: ${sid}/${wid}`);
    return buildConfig(sid, wid);
  } catch { return null; }
}

async function runPeek(cfg: Config): Promise<MailboxSummary | null> {
  // Pass MAILBOX_ROOT explicitly: peek reads the configured root, not the
  // ambient environment (which may point elsewhere or be unset).
  const proc = Bun.spawn([cfg.cliPath, "peek", "--session", cfg.sessionId, "--agent", cfg.agentId], {
    stdout: "pipe", stderr: "pipe", timeout: CHECK_TIMEOUT_MS,
    env: { ...process.env, MAILBOX_ROOT: cfg.mailboxRoot },
  });
  const out = await new Response(proc.stdout).text();
  if (!out.trim()) return null;
  try { return JSON.parse(out) as MailboxSummary; } catch { return null; }
}

function setupWatcher(inboxDir: string, poll: () => void): AbortController | null {
  const ac = new AbortController();
  try {
    // Bun.watch is not available on all Bun versions; Node's fs.watch is
    // stable across them. 'rename' fires for create/delete/rename — poll()
    // is idempotent (msg_id dedup) so redundant events are harmless.
    //
    // Keep the watcher reachable: a bare local variable gets GC'd by Bun
    // and events silently stop firing. Attach it to the returned
    // AbortController so the caller holds the only strong reference.
    const watcher = fsWatch(inboxDir, { signal: ac.signal }, () => {
      poll();
    });
    watcher.on("error", (e) => {
      console.error("[mailbox] watcher error:", e);
    });
    (ac as AbortController & { _watcher?: unknown })._watcher = watcher;
    return ac;
  } catch {
    return null; // inbox dir not ready — retry on next interval, no red noise
  }
}

export async function activate(pi: ExtensionAPI, ctx: ExtensionContext, cfg: Config, identityPath: string): Promise<void> {
  await checkMailboxCli(cfg.cliPath);

  let watcherAc: AbortController | null = null;
  let polling = false;
  const seen = new Set<string>();
  const sentAt = new Map<string, number>(); // msg_id → last send ts（窗口内同 id 不重发）
  const RETRY_MS = 60_000;

  // pi.sendMessage() 是同步返回、异步完成（内部 sendCustomMessage().catch）——
  // 同步 try/catch 捕获不到异步失败。去重策略（三层）：
  // ① 同步 throw（payload 非法/runtime 未初始化）→ catch → 不记录 → 下轮重发
  // ② 同 msg_id 在 RETRY_MS 窗口内不重发（防文件更新触发重复通知）
  // ③ send 后延迟 CHECK 秒再 peek：消息已被 agent read 消费（不再 pending）
  //    → 永久 seen；仍 pending → 窗口过期后下一轮 poll 重发（消息确实未处理，
  //    通知可能在异步阶段丢失——oracle 红线：不允许永久去重未送达消息）
  function scheduleSeenAfterConsumed(msgId: string): void {
    setTimeout(() => {
      runPeek(cfg).then((r) => {
        const stillPending = r?.messages.some((m) => m.msg_id === msgId) ?? false;
        try {
          writeFileSync(`/tmp/omp-ack-${process.pid}.json`, JSON.stringify({
            ts: new Date().toISOString(), msg_id: msgId, still_pending: stillPending,
          }));
        } catch { /* diagnostic only */ }
        if (!stillPending) {
          seen.add(msgId);
          if (seen.size > MAX_DEDUP_IDS) seen.delete(seen.values().next().value!);
        }
      }).catch(() => { /* keep un-seen; retry next poll */ });
    }, CHECK_TIMEOUT_MS);
  }

  async function poll(): Promise<void> {
    if (polling) return;
    polling = true;
    try {
      const result = await runPeek(cfg);
      try {
        writeFileSync(`/tmp/omp-poll-${process.pid}.json`, JSON.stringify({
          ts: new Date().toISOString(), pending: result?.pending ?? -1,
          msgs: result?.messages.map((m) => m.msg_id) ?? [],
        }));
      } catch { /* diagnostic only */ }
      if (!result || result.messages.length === 0) return;
      for (const msg of result.messages) {
        if (seen.has(msg.msg_id)) continue;
        const lastSent = sentAt.get(msg.msg_id);
        if (lastSent !== undefined && Date.now() - lastSent < RETRY_MS) continue;
        try {
          pi.sendMessage(
            { customType: "omp-mailbox", display: true,
              content: `📬 MAILBOX: ${result.pending} pending\nFrom: ${msg.from}  Kind: ${msg.kind}\nSubject: ${msg.subject}\n\n> notification — run mailbox read to consume`,
              details: { from: msg.from, kind: msg.kind } },
            { triggerTurn: true, deliverAs: "nextTurn" },
          );
          sentAt.set(msg.msg_id, Date.now());
          if (sentAt.size > MAX_DEDUP_IDS) {
            const oldest = sentAt.keys().next().value!;
            sentAt.delete(oldest);
          }
          try {
            writeFileSync(`/tmp/omp-send-${process.pid}.json`, JSON.stringify({
              ts: new Date().toISOString(), msg_id: msg.msg_id,
            }));
          } catch { /* diagnostic only */ }
        } catch (e: unknown) {
          console.error("[mailbox] sendMessage failed, keeping msg for retry:", e);
          continue;
        }
        scheduleSeenAfterConsumed(msg.msg_id);
      }
    } catch (e: unknown) { console.error("[mailbox] poll error:", e); } finally { polling = false; }
  }

  watcherAc = setupWatcher(cfg.inboxDir, poll);
  const interval = setInterval(() => { poll(); if (!watcherAc) watcherAc = setupWatcher(cfg.inboxDir, poll); }, POLL_MS);
  pi.on("agent_end", poll);
  pi.on("session_shutdown", () => {
    if (watcherAc) watcherAc.abort();
    clearInterval(interval);
    // identity 文件由 launcher（OMPRunner）管理生命周期，plugin 不删除。
    // 当 agent HOT_PARKED 时，launcher 跳过删除以保留 revive 能力。
  });

  poll();
}

export default function (pi: ExtensionAPI, ctx: ExtensionContext): void {
  // ── load marker（oracle-lite P1 诊断）：区分「extension 未被加载」vs「被调用但失败」
  // 注意：ESM 下不可用 require()（ReferenceError）——用 fs 命名导入。
  try {
    writeFileSync(`/tmp/omp-mb-load-${process.pid}.json`, JSON.stringify({
      pid: process.pid,
      identity_env: !!process.env.OMP_MAILBOX_IDENTITY_FILE,
      loaded_at: new Date().toISOString(),
    }));
  } catch { /* diagnostic only */ }

  const identityPath = process.env.OMP_MAILBOX_IDENTITY_FILE;
  if (!identityPath) {
    return;  // Manager session — no mailbox monitoring needed
  }

  // Poll for agent-written identity JSON every2s; activate when found
  const idInterval = setInterval(() => {
    let cfg: Config | null = null;
    try {
      cfg = readIdentityFile(identityPath);
    } catch (e: unknown) {
      console.error("[mailbox] identity read error:", e);
      return;
    }
    if (!cfg) return;
    clearInterval(idInterval);
    activate(pi, ctx, cfg, identityPath).catch((e: unknown) => {
      console.error("[mailbox] activation failed:", e);
    });
  }, IDENTITY_POLL_MS);

  pi.on("session_shutdown", () => {
    clearInterval(idInterval);
    // identity 由 launcher 管理，plugin 不删除
  });
}
