import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { readFileSync, existsSync, unlinkSync, writeFileSync, watch as fsWatch, mkdirSync, readdirSync, renameSync, statSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const POLL_MS = 30_000;
const IDENTITY_POLL_MS = 2_000;
const CHECK_TIMEOUT_MS = 5_000;
const GATEWAY_TIMEOUT_MS = 5_000;
const MAX_DEDUP_IDS = 100;
const MAILBOX_MIN_VERSION = "0.1.0";
const MAX_UI_ENTRIES = 50;
const UI_DEBOUNCE_MS = 500;
const RETRY_NOTIFY_MS = 300_000; // A11.3: re-push interval for unclaimed messages (was 60s)
// P3-19b: dedup state is persisted so a crashed/restarted runtime never
// re-pushes (with triggerTurn) messages already notified, nor re-notifies
// consumed ones. Saved debounced + on shutdown.
const DEDUP_STATE_FILE = ".mailbox-dedup.json";
const DEDUP_SAVE_DEBOUNCE_MS = 500;
// P3-19c: when comparing a live pid's process start time against the
// identity file mtime, allow clock/fs rounding slack (5s).
const PID_START_TOLERANCE_MS = 5_000;
// R4: cached backend session id — captured once at session_start (where the
// real ExtensionContext/sessionManager is available), reused by heartbeat
// restore re-register (where only the outer empty ctx is in scope).
let capturedBackendSessionId = "";
// P3-19d: sweep stale launcher identity files every 10 min (one-shot sweep
// also runs at activation) so ~/.omp/mailbox-identity stops accumulating.
const IDENTITY_CLEANUP_MS = 10 * 60_000;

/** Launcher identity (0600 file created by aimeshchat, read-only here). */
export interface GatewayIdentity {
  session_id: string;
  agent_id: string;
  runtime_id: string;
  review_key: string;
  generation: number;
  gateway_socket: string;
  owner_pid: number;
  nonce: string;
}

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
  const root = process.env.MAILBOX_ROOT ?? `${homedir()}/.local/share/aimeshchat/mailbox`;
  const cli = process.env.MAILBOX_CLI ?? "mailbox";
  return { sessionId, agentId, mailboxRoot: root, cliPath: cli, inboxDir: `${root}/${sessionId}/${agentId}/inbox` };
}

// A11.1: truncate a UTF-8 body to a 2KB byte budget without splitting
// multi-byte chars (char-slicing would let a CJK body exceed the budget).
function truncateUtf8(s: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(s);
  if (bytes.length <= maxBytes) return s;
  return new TextDecoder("utf-8").decode(bytes.subarray(0, maxBytes));
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
    const proc = Bun.spawn(["aimeshchat", "--version"], { stdout: "pipe", stderr: "pipe", timeout: CHECK_TIMEOUT_MS });
    const out = await new Response(proc.stdout).text();
    const match = out.match(/(\d+\.\d+\.\d+)/);
    if (match && proc.exitCode === 0) {
      if (!versionGte(match[1], MAILBOX_MIN_VERSION)) {
        console.error(`[mailbox] aimeshchat version ${match[1]} < required ${MAILBOX_MIN_VERSION}. Please upgrade aimeshchat.`);
        throw new Error(`mailbox CLI version too old: ${match[1]} < ${MAILBOX_MIN_VERSION}`);
      }
      return;
    }
  } catch { /* fall through to existence check */ }

  try {
    const proc = Bun.spawn([cliPath, "--help"], { stdout: "pipe", stderr: "pipe", timeout: CHECK_TIMEOUT_MS });
    await proc.exited;
    if (proc.exitCode !== 0) {
      console.error(`[mailbox] CLI '${cliPath}' is not callable (exit ${proc.exitCode}). Is aimeshchat installed? (pipx install aimeshchat)`);
      throw new Error(`mailbox CLI not functional: ${cliPath}`);
    }
  } catch (e) {
    console.error(`[mailbox] CLI '${cliPath}' not found in PATH. Set MAILBOX_CLI or install aimeshchat (pipx install aimeshchat).`);
    throw new Error(`mailbox CLI not found: ${cliPath}`);
  }
}

// ── Gateway UDS client (Node net — one request per connection) ────────

export interface GatewayResponse {
  v: number;
  id: string;
  ok: boolean;
  result?: Record<string, unknown>;
  error?: { code: string; message: string; context?: Record<string, unknown> } | null;
}

export class GatewayClient {
  private socketPath: string;
  private timeoutMs: number;

  constructor(socketPath: string, timeoutMs: number = GATEWAY_TIMEOUT_MS) {
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
  }

  /** Send one NDJSON request, await one response. */
  call(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      if (!existsSync(this.socketPath)) {
        reject(new Error(`gateway socket not found: ${this.socketPath}`));
        return;
      }
      const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      const req = JSON.stringify({ v: 1, id, method, params }) + "\n";
      const sock: Socket = createConnection(this.socketPath);
      let buf = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        sock.destroy();
        reject(new Error(`gateway RPC timeout: ${method}`));
      }, this.timeoutMs);
      sock.on("connect", () => sock.write(req));
      sock.on("data", (chunk) => {
        buf += chunk.toString("utf-8");
        if (buf.includes("\n")) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const line = buf.split("\n", 1)[0];
          try {
            const resp = JSON.parse(line) as GatewayResponse;
            if (!resp.ok) {
              const err = resp.error ?? { code: "INTERNAL", message: "gateway error" };
              reject(new Error(`[${err.code}] ${err.message}`));
            } else {
              resolve(resp.result ?? {});
            }
          } catch (e) {
            reject(new Error(`gateway bad response: ${(e as Error).message}`));
          }
          sock.destroy();
        }
      });
      sock.on("error", (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`gateway connect failed: ${e.message}`));
      });
    });
  }
}

// ── Identity ───────────────────────────────────────────────────────────

// P3-19c: process start time (epoch ms) of a live pid, or null if
// unavailable. Used to detect PID reuse: a pid whose process started AFTER
// the identity file was written cannot be the original launcher.
function processStartTimeMs(pid: number): number | null {
  try {
    if (process.platform === "darwin") {
      // Elapsed time is timezone-independent ("[[DD-]HH:]MM:SS"); deriving
      // start = now - elapsed avoids Date.parse TZ pitfalls (bun test runs
      // with TZ=UTC while ps reports system-local start time).
      const out = Bun.spawnSync(["ps", "-o", "etime=", "-p", String(pid)], {
        stdout: "pipe", stderr: "pipe",
      });
      const s = out.stdout.toString().trim();
      if (!s) return null;
      const m = s.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
      if (!m) return null;
      const dd = Number(m[1] ?? 0), hh = Number(m[2] ?? 0), mm = Number(m[3]), ss = Number(m[4]);
      if (![dd, hh, mm, ss].every(Number.isFinite)) return null;
      return Date.now() - ((dd * 86400 + hh * 3600 + mm * 60 + ss) * 1000);
    }
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
      // comm (field 2) may contain spaces/parens — split after the last ')'.
      const close = stat.lastIndexOf(")");
      const fields = stat.slice(close + 2).split(" ");
      const startTicks = Number(fields[19]); // field 22 overall, 0-based after 3
      if (!Number.isFinite(startTicks)) return null;
      let btime = 0;
      for (const line of readFileSync("/proc/stat", "utf-8").split("\n")) {
        if (line.startsWith("btime ")) { btime = Number(line.slice(6)); break; }
      }
      // starttime is in clock ticks since boot; USER_HZ is 100 on Linux.
      return (btime + startTicks / 100) * 1000;
    }
  } catch { /* pid gone or procfs unavailable */ }
  return null;
}

export function readIdentityFile(path: string): GatewayIdentity | null {
  try {
    if (!existsSync(path)) return null;
    const data = JSON.parse(readFileSync(path, "utf-8"));

    const ownerPid = data.owner_pid as number | undefined;
    if (ownerPid) {
      try {
        process.kill(ownerPid, 0); // signal 0 = existence check
      } catch {
        return null; // PID no longer alive — stale identity
      }
      // P3-19c: an alive pid may have been recycled by an unrelated process
      // (the original launcher died, kernel reused the number). The launcher
      // wrote this file from its own process, so its start time is at or
      // before the file mtime; a start time after mtime ⇒ PID reuse.
      const startMs = processStartTimeMs(ownerPid);
      if (startMs !== null) {
        let mtimeMs = 0;
        try { mtimeMs = statSync(path).mtimeMs; } catch { /* unreadable — fall through */ }
        if (mtimeMs > 0 && startMs > mtimeMs + PID_START_TOLERANCE_MS) {
          console.warn(`[mailbox] identity ${path}: owner_pid ${ownerPid} reused by a newer process — rejecting stale identity`);
          return null;
        }
      }
    }

    const expectedNonce = process.env.OMP_MAILBOX_NONCE;
    if (data.nonce && expectedNonce && data.nonce !== expectedNonce) {
      return null; // nonce mismatch — identity from a different launcher
    }

    const sid = data.session_id ?? data.sessionId;
    const wid = data.agent_id ?? data.worker_id ?? data.agentId ?? data.workerId;
    if (!sid || !wid) return null;
    console.warn(`[mailbox] identity: ${sid}/${wid} runtime=${data.runtime_id ?? "?"} gen=${data.generation ?? 1}`);
    return {
      session_id: sid,
      agent_id: wid,
      runtime_id: data.runtime_id ?? "",
      review_key: data.review_key ?? "",
      generation: data.generation ?? 1,
      gateway_socket: data.gateway_socket ?? "",
      owner_pid: data.owner_pid ?? 0,
      nonce: data.nonce ?? "",
    };
  } catch { return null; }
}

// P3-19d: sweep stale launcher identity files (dead/missing owner_pid or
// unreadable/corrupt) so ~/.omp/mailbox-identity does not accumulate
// hundreds of leftovers across launcher runs. The plugin's own identity
// file is never removed; files whose owner is alive are kept (another
// runtime may still be reading them).
function cleanupIdentityDir(identityDir: string, ownPath: string): void {
  let entries: string[];
  try {
    entries = readdirSync(identityDir);
  } catch { return; } // dir missing — nothing to clean
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const p = join(identityDir, name);
    if (p === ownPath) continue;
    let stale = false;
    try {
      const data = JSON.parse(readFileSync(p, "utf-8")) as { owner_pid?: unknown };
      const pid = typeof data.owner_pid === "number" ? data.owner_pid : 0;
      if (!pid) {
        stale = true; // no owner info — cannot be a live launcher identity
      } else {
        try { process.kill(pid, 0); } catch { stale = true; }
      }
    } catch { stale = true; } // corrupt/unreadable → stale
    if (stale) {
      try { unlinkSync(p); } catch { /* raced with another sweep — ignore */ }
    }
  }
}

// ── Dedup state persistence (P3-19b) ──────────────────────────────────

interface DedupState {
  seen: string[];
  notifiedAt: Record<string, number>; // msg_id → last notified epoch ms
  savedAt: number;
}

function dedupStatePath(cfg: Config): string {
  return `${cfg.mailboxRoot}/${cfg.sessionId}/${cfg.agentId}/${DEDUP_STATE_FILE}`;
}

/** Load persisted dedup state; returns empty sets when absent/corrupt. */
function loadDedupState(cfg: Config): { seen: Set<string>; notifiedAt: Map<string, number> } {
  const seen = new Set<string>();
  const notifiedAt = new Map<string, number>();
  try {
    const state = JSON.parse(readFileSync(dedupStatePath(cfg), "utf-8")) as Partial<DedupState>;
    if (Array.isArray(state.seen)) for (const id of state.seen) if (typeof id === "string") seen.add(id);
    if (state.notifiedAt && typeof state.notifiedAt === "object") {
      for (const [id, ts] of Object.entries(state.notifiedAt)) {
        if (typeof ts === "number") notifiedAt.set(id, ts);
      }
    }
  } catch { /* no state yet — fresh start */ }
  // Bound restored state to the same caps the runtime enforces in memory.
  while (seen.size > MAX_DEDUP_IDS) seen.delete(seen.values().next().value!);
  while (notifiedAt.size > MAX_DEDUP_IDS) notifiedAt.delete(notifiedAt.keys().next().value!);
  return { seen, notifiedAt };
}

/** Persist dedup state (tmp + rename so a crash mid-write cannot corrupt). */
function persistDedupState(cfg: Config, seen: Set<string>, notifiedAt: Map<string, number>): void {
  try {
    const dir = `${cfg.mailboxRoot}/${cfg.sessionId}/${cfg.agentId}`;
    mkdirSync(dir, { recursive: true });
    const target = dedupStatePath(cfg);
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, JSON.stringify({ seen: [...seen], notifiedAt: Object.fromEntries(notifiedAt), savedAt: Date.now() } satisfies DedupState));
    try { renameSync(tmp, target); } catch { unlinkSync(tmp); /* retried on next change */ }
  } catch { /* state dir unwritable — dedup degrades to in-memory only */ }
}

async function runPeek(cfg: Config): Promise<MailboxSummary | null> {
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
    const watcher = fsWatch(inboxDir, { signal: ac.signal }, () => {
      poll();
    });
    watcher.on("error", (e) => {
      // AbortError is the normal shutdown path — not an error.
      if ((e as { name?: string }).name === "AbortError") return;
      console.error("[mailbox] watcher error:", e);
    });
    (ac as AbortController & { _watcher?: unknown })._watcher = watcher;
    return ac;
  } catch {
    return null;
  }
}

// ── UI helpers (runtime state widget) ──────────────────────────────────

interface UiState {
  runtimeId: string;
  sessionId: string;
  agentId: string;
  status: string;
  startedAt: number;
  lastEvent: string;
  lastEventAt: string;
  toolCount: number;
  pendingInbox: number;
  receipt: string;
  parkMethod: string;
  recent: { ts: string; text: string }[];
}

function makeUiState(identity: GatewayIdentity): UiState {
  return {
    runtimeId: identity.runtime_id,
    sessionId: identity.session_id,
    agentId: identity.agent_id,
    status: "handshaking",
    startedAt: Date.now(),
    lastEvent: "",
    lastEventAt: "",
    toolCount: 0,
    pendingInbox: 0,
    receipt: "",
    parkMethod: "",
    recent: [],
  };
}

function pushRecent(state: UiState, text: string): void {
  state.recent.push({ ts: new Date().toISOString().slice(11, 19), text });
  if (state.recent.length > MAX_UI_ENTRIES) {
    state.recent = state.recent.slice(-MAX_UI_ENTRIES);
  }
}

function renderUi(ctx: ExtensionContext, state: UiState | null): void {
  if (!state) return;
  if (!ctx || ctx.hasUI === false) return; // no UI — still report events
  try {
    ctx.ui.setStatus("runtime", `[${state.agentId}] ${state.status} · ${state.toolCount} tools · inbox ${state.pendingInbox}`);
    ctx.ui.setWorkingMessage(state.lastEvent ? `[runtime] ${state.lastEvent.slice(0, 120)}` : undefined);
    const lines = state.recent.slice(-8).map((r) => `  ${r.ts}  ${r.text}`).join("\n");
    ctx.ui.setWidget("runtime-status", [
      `Runtime ${state.runtimeId.slice(0, 10)} (${state.sessionId})`,
      `status: ${state.status}`,
      `elapsed: ${Math.round((Date.now() - state.startedAt) / 1000)}s`,
      `last event: ${state.lastEvent}`,
      `tools: ${state.toolCount}`,
      `pending inbox: ${state.pendingInbox}`,
      `receipt: ${state.receipt || "—"}`,
      `park: ${state.parkMethod || "—"}`,
      lines,
    ]);
  } catch { /* UI unavailable — non-fatal */ }
}

// ── Runtime events → Gateway ──────────────────────────────────────────

export class RuntimeEventReporter {
  private client: GatewayClient | null = null;
  private identity: GatewayIdentity;
  private state: UiState | null = null;
  private ctx: ExtensionContext | null = null;

  constructor(identity: GatewayIdentity, ctx: ExtensionContext) {
    this.identity = identity;
    if (identity.gateway_socket) {
      this.client = new GatewayClient(identity.gateway_socket);
    }
    this.state = makeUiState(identity);
    this.ctx = ctx;
  }

  private buildEvent(kind: string, payload: Record<string, unknown>): Record<string, unknown> {
    return {
      runtime_id: this.identity.runtime_id,
      generation: this.identity.generation,
      session_id: this.identity.session_id,
      agent_id: this.identity.agent_id,
      request_id: payload.request_id ?? "",
      run_id: payload.run_id ?? "",
      kind,
      created_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      payload,
    };
  }

  /** Fire-and-forget report — logs failures, resolves regardless. */
  report(kind: string, payload: Record<string, unknown>): Promise<void> {
    if (!this.client) return Promise.resolve();
    return this.client.call("runtime.event", { event: this.buildEvent(kind, payload) }).then(() => undefined).catch((e) => {
      console.error(`[mailbox] runtime.event failed: ${(e as Error).message}`);
    });
  }

  /**
   * P3-19a: retrying report for terminal state events (e.g. TASK_STATE
   * agent_end) that must not be silently dropped when the gateway is
   * briefly unreachable — the gateway relies on them for run accounting.
   * Unlike report(), each attempt is awaited/re-scheduled on failure
   * (exponential backoff: baseDelayMs, 2x, 4x, …).
   */
  reportRetry(kind: string, payload: Record<string, unknown>, attempts = 3, baseDelayMs = 500): void {
    if (!this.client) return;
    const attempt = (n: number): void => {
      this.client!.call("runtime.event", { event: this.buildEvent(kind, payload) }).catch((e) => {
        console.error(`[mailbox] runtime.event ${kind} attempt ${n}/${attempts} failed: ${(e as Error).message}`);
        if (n < attempts) setTimeout(() => attempt(n + 1), baseDelayMs * 2 ** (n - 1));
      });
    };
    attempt(1);
  }

  /**
   * Debounced progress report (message_update / tool_execution_update):
   * at most one per 500ms window for non-terminal kinds. start/end/
   * receipt/terminal events use report() directly (never debounced).
   */
  reportDebounced(kind: string, payload: Record<string, unknown>): void {
    if (!this.client) return;
    const now = Date.now();
    if (now - this._lastDebouncedAt < UI_DEBOUNCE_MS) return;
    this._lastDebouncedAt = now;
    this.report(kind, payload);
  }

  private _lastDebouncedAt = 0;

  updateUi(text: string): void {
    if (!this.state) return;
    this.state.lastEvent = text;
    this.state.lastEventAt = new Date().toISOString();
    pushRecent(this.state, text);
    renderUi(this.ctx!, this.state);
  }

  setStatus(status: string): void {
    if (this.state) this.state.status = status;
    renderUi(this.ctx!, this.state);
  }

  bumpTools(): void {
    if (this.state) this.state.toolCount += 1;
  }

  setPending(n: number): void {
    if (this.state) this.state.pendingInbox = n;
  }

  setReceipt(text: string): void {
    if (this.state) this.state.receipt = text;
  }

  setPark(method: string): void {
    if (this.state) this.state.parkMethod = method;
  }

  snapshot(): UiState | null {
    return this.state;
  }

  toolCount(): number {
    return this.state?.toolCount ?? 0;
  }

  // A13: refresh widget tool stats from gateway-aggregated EventStore
  // (source of truth). In-process counter (bumpTools) provides immediate
  // feedback; this reconciles periodically via runtime.info.
  async refreshToolStats(): Promise<void> {
    if (!this.client || !this.state) return;
    try {
      const info = await this.client.call("runtime.info", { runtime_id: this.identity.runtime_id });
      const stats = (info.tool_stats ?? {}) as { tool_count?: unknown; error_count?: unknown };
      if (typeof stats.tool_count === "number") {
        this.state.toolCount = stats.tool_count;
        renderUi(this.ctx!, this.state);
      }
    } catch { /* gateway may not support runtime.info — keep in-process count */ }
  }
}

// ── runtime adapter activation (worker/oracle) ────────────────────────

export async function activate(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  cfg: Config,
  identityPath: string,
): Promise<void> {
  // Version/capability self-check: RuntimeEventReporter is declared in this
  // module (always defined), so typeof is meaningless here. The real
  // capability signal is the gateway_socket handshake — without it the
  // gateway marks this runtime offline in ~2min.
  const identity = readIdentityFile(identityPath);
  const HAS_REPORTER = Boolean(identity?.gateway_socket);
  if (!HAS_REPORTER) {
    console.error("[omp-mailbox-plugin] WARNING: running old version without RuntimeEventReporter — gateway will mark this runtime offline in ~2min. Reinstall from github:comicchang/omp-mailbox-plugin@main");
  }

  // P1-11: checkMailboxCli 失败单独标记不阻断 activate 重试。
  // CLI 暂不可用时（如升级中、PATH 未就绪）不应阻止整个插件激活。
  let cliOk = true;
  try {
    await checkMailboxCli(cfg.cliPath);
  } catch (e: unknown) {
    cliOk = false;
    console.warn("[mailbox] checkMailboxCli failed (non-fatal, activate continues):", e);
  }

  let watcherAc: AbortController | null = null;
  let polling = false;
  // P3-19b: dedup state persisted across restarts (see loadDedupState) —
  // a crashed runtime must not re-push+triggerTurn messages already
  // notified, nor re-notify consumed ones.
  const { seen, notifiedAt } = loadDedupState(cfg);
  // P3-19b: debounced save whenever seen/notifiedAt change; flushed
  // synchronously on session_shutdown so the latest state survives crashes.
  let dedupSaveTimer: Timer | undefined;
  const scheduleDedupSave = (): void => {
    clearTimeout(dedupSaveTimer);
    dedupSaveTimer = setTimeout(() => {
      dedupSaveTimer = undefined;
      persistDedupState(cfg, seen, notifiedAt);
    }, DEDUP_SAVE_DEBOUNCE_MS);
  };

  // ── Gateway handshake (best-effort) ────────────────────────────────
  let reporter: RuntimeEventReporter | null = null;
  let initialTask = "";
    if (identity) {
        reporter = new RuntimeEventReporter(identity, ctx);
        let handshakeResult: Record<string, unknown> | null = null;
        if (identity.gateway_socket) {
            try {
                // Real backend session id (OMP session) — enables warm resume
                // even if the gateway restarts and the in-memory record is lost.
                let backendSessionId = "";
                try {
                    backendSessionId = ctx?.sessionManager?.getSessionId?.() ?? "";
                } catch { /* session manager may be unavailable pre-session_start */ }
                handshakeResult = await new GatewayClient(identity.gateway_socket).call("runtime.register", {
                    session_id: identity.session_id,
                    agent_id: identity.agent_id,
                    runtime_id: identity.runtime_id,
                    review_key: identity.review_key,
                    generation: identity.generation,
                    backend_session_id: backendSessionId,
                    runtime: "omp",
                    owner_pid: identity.owner_pid,
                    nonce: identity.nonce,
                });
                initialTask = (handshakeResult.initial_task as string) ?? "";
                reporter.setStatus("active");
                reporter.updateUi(`gateway handshake ok (session ${backendSessionId || "?"})`);
                reporter.report("RUNTIME_STATE", { state: "handshake_ok", backend_session_id: backendSessionId });
            } catch (e) {
                console.error(`[mailbox] gateway handshake failed: ${(e as Error).message}`);
                reporter.setStatus("handshake-failed");
            }
        }
        // First TASK → pi.sendUserMessage (real user turn, not a notification).
        const initialTaskMsgId = (handshakeResult?.initial_task_msg_id as string) ?? "";
        if (initialTask) {
            try {
                pi.sendUserMessage(initialTask);
                reporter.updateUi("initial task dispatched");
            } catch (e) {
                console.error(`[mailbox] initial task dispatch failed: ${(e as Error).message}`);
            }
        }
        // Consume the delivered initial task (claim + finalize) so a stale
        // unclaimed TASK is never re-delivered on the next warm resume.
        if (identity.gateway_socket && initialTaskMsgId) {
            try {
                const client = new GatewayClient(identity.gateway_socket);
                // P1-8: pass known initialTaskMsgId to claim the exact
                // message, not the oldest unclaimed.
                const read = await client.call("message.read", {
                    session_id: identity.session_id,
                    agent: identity.agent_id,
                    owner: identity.agent_id,
                    msg_id: initialTaskMsgId,
                });
                const claimedId = (read.message as { msg_id?: string } | null)?.msg_id ?? "";
                if (claimedId) {
                    await client.call("message.finalize", {
                        session_id: identity.session_id,
                        agent: identity.agent_id,
                        msg_id: claimedId,
                        owner: identity.agent_id,
                    });
                    reporter.updateUi(`initial task ${claimedId.slice(0, 8)} consumed`);
                }
            } catch (e) {
                console.error(`[mailbox] initial task consume failed: ${(e as Error).message}`);
            }
        }
    }

  // ── Lifecycle hooks → RuntimeEvent ─────────────────────────────────
  const on = (evt: string, fn: () => void) => {
    try { pi.on(evt as never, fn as never); } catch { /* hook unavailable */ }
  };
  on("agent_start", () => {
    if (reporter) {
      reporter.setStatus("agent-running");
      reporter.report("RUNTIME_STATE", { state: "agent_start" });
      reporter.updateUi("agent started");
    }
  });
  // session_start: the real OMP session id becomes available only after the
  // session initializes — re-register with backend_session_id so the gateway
  // can sync it into the park manifest (warm resume across gateway restarts).
  // 注意：必须用 handler 的 ctx 参数（session_start 事件的 ExtensionContext），
  // 而非 activate 的外层 ctx（可能是空对象 fallback，getSessionId 恒空）。
  on("session_start", ((_evt: unknown, handlerCtx: ExtensionContext) => {
    if (!identity?.gateway_socket) return;
    let backendSessionId = "";
    try {
      backendSessionId = handlerCtx?.sessionManager?.getSessionId?.() ?? "";
    } catch { /* not ready yet */ }
    if (backendSessionId) capturedBackendSessionId = backendSessionId; // R4: 缓存供 heartbeat 恢复复用
    if (!backendSessionId) return;
    new GatewayClient(identity.gateway_socket).call("runtime.register", {
      session_id: identity.session_id,
      agent_id: identity.agent_id,
      runtime_id: identity.runtime_id,
      review_key: identity.review_key,
      generation: identity.generation,
      backend_session_id: backendSessionId,
      runtime: "omp",
      owner_pid: identity.owner_pid,
      nonce: identity.nonce,
    }).catch((e) => {
      console.error(`[mailbox] session_start re-register failed: ${(e as Error).message}`);
    });
  }) as never);
  on("turn_start", () => {
    if (reporter) {
      reporter.report("TURN_STARTED", {});
      reporter.updateUi("turn started");
    }
  });
  on("turn_end", () => {
    if (reporter) {
      reporter.reportDebounced("ASSISTANT_PROGRESS", { stage: "turn_end" });
      reporter.updateUi("turn ended");
    }
  });
  on("tool_call", () => {
    if (reporter) {
      reporter.bumpTools();
      reporter.report("TOOL_STARTED", {});
      reporter.updateUi(`tool call #${reporter.toolCount() ?? "?"}`);
    }
  });
  on("tool_result", () => {
    if (reporter) {
      reporter.report("TOOL_FINISHED", {});
      reporter.updateUi("tool finished");
    }
  });
  on("agent_end", () => {
    if (reporter) {
      reporter.setStatus("agent-ended");
      // P3-19a: TASK_STATE agent_end is terminal — retry delivery (3x,
      // 500ms/1s/2s backoff) instead of fire-and-forget so the gateway
      // reliably records run completion even if it is briefly unreachable.
      reporter.reportRetry("TASK_STATE", { state: "agent_end" });
      reporter.updateUi("agent ended");
    }
  });
  on("session_shutdown", () => {
    // Cancel subscriptions + clean up THIS generation identity only.
    // A hot parked runtime is NOT released by a Manager session switch.
    if (watcherAc) watcherAc.abort();
    clearInterval(interval);
    if (reporter) reporter.report("RUNTIME_STATE", { state: "session_shutdown" });
  });

  // ── Watcher: peek + notify only (never consumes; receipts come from
  //    the tool's gateway read). ──────────────────────────────────────
  /** Read the pending message body from its inbox file (peek summary has no body). */
  function readBodySnippet(msgId: string): string {
    try {
      const raw = readFileSync(`${cfg.inboxDir}/${msgId}.json`, "utf-8");
      const parsed = JSON.parse(raw) as { body?: unknown };
      if (typeof parsed.body === "string") return truncateUtf8(parsed.body, 2048);
    } catch { /* body not yet durable / unreadable */ }
    return "";
  }

  // A11.4: detect whether the agent can claim messages on its own.
  // If getActiveTools is unavailable (old runtime, test mock) → assume
  // the agent can claim → keep notify-only behaviour (safe fallback).
  function agentHasClaimTool(piApi: ExtensionAPI): boolean {
    try {
      const tools = typeof piApi.getActiveTools === "function" ? piApi.getActiveTools() : null;
      if (!tools) return true;
      if (tools.includes("bash")) return true; // can claim via `mailbox read` CLI
      // A11.4: bare "read" is the generic file-read tool (present on every
      // agent) — matching it would false-positive and defeat the degradation
      // for restricted-tool oracles. Match claim-capable names only.
      return tools.some((t) => /(mailbox|inbox|claim)/i.test(t));
    } catch { return true; }
  }

  async function poll(): Promise<void> {
    if (polling) return;
    polling = true;
    try {
      const result = await runPeek(cfg);
      if (reporter) reporter.setPending(result?.pending ?? 0);
      if (reporter) renderUi(ctx, reporter.snapshot());
      if (!result) return;
      // A11.2: consumed messages → seen.add immediately (no 5s delay).
      // Messages no longer in peek (pending=0) have been claimed/finalized.
      // Runs before the empty-check so bookkeeping keeps up even when the
      // inbox just drained to zero.
      for (const [msgId] of notifiedAt) {
        if (!result.messages.some((m) => m.msg_id === msgId)) {
          seen.add(msgId);
          notifiedAt.delete(msgId);
          if (seen.size > MAX_DEDUP_IDS) seen.delete(seen.values().next().value!);
          scheduleDedupSave(); // P3-19b
        }
      }
      if (result.messages.length === 0) return;
      for (const msg of result.messages) {
        if (seen.has(msg.msg_id)) continue;
        const firstPush = !notifiedAt.has(msg.msg_id); // A11.3
        // A11.3: second+ push waits RETRY_NOTIFY_MS (was 60s, now 300s)
        if (!firstPush && Date.now() - notifiedAt.get(msg.msg_id)! < RETRY_NOTIFY_MS) continue;
        try {
          // Delivery mode: in-loop messages use "steer" while the agent is
          // running; idle / turn wrap-up uses "nextTurn" (hidden from the
          // pending-message UI). First TASK goes through sendUserMessage in
          // the handshake, not here. ctx.isIdle may be absent on some
          // runtimes — default to nextTurn.
          let deliverAs: "steer" | "nextTurn" = "nextTurn";
          try {
            if (typeof ctx?.isIdle === "function" && !ctx.isIdle()) deliverAs = "steer";
          } catch { /* fall through to nextTurn */ }
          // A11.1: include the message body so the notification is actionable
          // even without the claim tool.
          const body = readBodySnippet(msg.msg_id);
          const bodyBlock = body ? `\n${body}\n` : "";

          // A11.4: claim degradation — when the agent has no claim tool
          // (e.g. oracle with restricted tools), auto read+finalize the
          // message and direct-deliver its body as a user turn.
          if (identity?.gateway_socket && !agentHasClaimTool(pi) && msg.kind === "TASK") {
            try {
              const claimClient = new GatewayClient(identity.gateway_socket);
              // P1-8: pass msg_id to claim the exact notified message,
              // not the oldest unclaimed — prevents claim-drift when
              // multiple messages are pending.
              const read = await claimClient.call("message.read", {
                session_id: cfg.sessionId,
                agent: cfg.agentId,
                owner: cfg.agentId,
                msg_id: msg.msg_id,
              });
              const claimedId = (read.message as { msg_id?: string } | null)?.msg_id ?? msg.msg_id;
              if (claimedId) {
                await claimClient.call("message.finalize", {
                  session_id: cfg.sessionId,
                  agent: cfg.agentId,
                  msg_id: claimedId,
                  owner: cfg.agentId,
                });
              }
              // A11.4: direct delivery as a real user turn
              pi.sendUserMessage(body || msg.subject || msg.kind);
              seen.add(msg.msg_id);
              if (seen.size > MAX_DEDUP_IDS) seen.delete(seen.values().next().value!);
              scheduleDedupSave(); // P3-19b
              if (reporter) reporter.updateUi(`auto-claimed ${msg.msg_id.slice(0, 8)}`);
            } catch (e) {
              console.error("[mailbox] claim fallback failed, retrying later:", e);
              continue;
            }
            continue;
          }

          // Normal notify path (agent has claim tool or not a TASK).
          pi.sendMessage(
            { customType: "omp-mailbox", display: true,
              content: `📬 MAILBOX: ${result.pending} pending\nFrom: ${msg.from}  Kind: ${msg.kind}\nSubject: ${msg.subject}${bodyBlock}\n> 消息正文已附上；领取请用 /agent-inbox read（未领取将低频重推）`,
              details: { from: msg.from, kind: msg.kind, subject: msg.subject, body } },
            { triggerTurn: firstPush, deliverAs }, // A11.3: triggerTurn only on first push
          );
          notifiedAt.set(msg.msg_id, Date.now());
          if (notifiedAt.size > MAX_DEDUP_IDS) notifiedAt.delete(notifiedAt.keys().next().value!);
          scheduleDedupSave(); // P3-19b
        } catch (e: unknown) {
          console.error("[mailbox] sendMessage failed, keeping msg for retry:", e);
          continue;
        }
      }
    } catch (e: unknown) { console.error("[mailbox] poll error:", e); } finally { polling = false; }
  }

  watcherAc = setupWatcher(cfg.inboxDir, poll);
  const interval = setInterval(() => { poll(); if (!watcherAc) watcherAc = setupWatcher(cfg.inboxDir, poll); }, POLL_MS);

  // P3-19d: sweep stale launcher identity files once at activation, then
  // periodically — otherwise ~/.omp/mailbox-identity accumulates leftovers
  // from every launcher run (observed 200+ files).
  const identityDir = dirname(identityPath);
  cleanupIdentityDir(identityDir, identityPath);
  const cleanupInterval = setInterval(() => {
    cleanupIdentityDir(identityDir, identityPath);
  }, IDENTITY_CLEANUP_MS);

  // ── Heartbeat: keeps the gateway's last_activity fresh (hot liveness +
  //    park lease renew). The gateway treats any runtime.event as activity;
  //    the heartbeat guarantees a cadence even when idle. ────────────
  const HEARTBEAT_MS = 60_000;
  // P3-q: track consecutive heartbeat failures to clear stale presence
  // and trigger re-registration after a gateway restart/reconnect.
  let heartbeatFailures = 0;
  const HEARTBEAT_STALE_THRESHOLD = 3; // 3 consecutive failures → stale
  const heartbeat = setInterval(() => {
    if (!identity?.gateway_socket) return;
    new GatewayClient(identity.gateway_socket).call("runtime.heartbeat", {
      runtime_id: identity.runtime_id,
    }).then(() => {
      // P3-q: success → reset failure counter; restore status if recovering
      if (heartbeatFailures > 0) {
        heartbeatFailures = 0;
        if (reporter) {
          reporter.setStatus("active");
          reporter.updateUi("heartbeat recovered");
        }
      }
    }).catch(() => {
      // P3-q: on failure, increment counter; after threshold, mark stale
      // and attempt re-registration so the gateway can restore presence
      // after a restart (runtime.register is idempotent).
      heartbeatFailures += 1;
      if (heartbeatFailures >= HEARTBEAT_STALE_THRESHOLD) {
        if (reporter) {
          reporter.setStatus("stale");
          reporter.updateUi(`heartbeat stale (${heartbeatFailures} failures)`);
        }
        // Attempt re-registration to restore presence.
        try {
          const rc = new GatewayClient(identity.gateway_socket);
          rc.call("runtime.register", {
            session_id: identity.session_id,
            agent_id: identity.agent_id,
            runtime_id: identity.runtime_id,
            review_key: identity.review_key,
            generation: identity.generation,
            backend_session_id: capturedBackendSessionId || ctx?.sessionManager?.getSessionId?.() || "",
            runtime: "omp",
            owner_pid: identity.owner_pid,
            nonce: identity.nonce,
          }).then(() => {
            heartbeatFailures = 0;
            if (reporter) {
              reporter.setStatus("active");
              reporter.updateUi("presence restored after re-register");
            }
          }).catch(() => { /* re-register also failed — retry next threshold */ });
        } catch { /* socket missing — retry next tick */ }
      }
    });
    // A13: reconcile widget tool counter with gateway-aggregated tool_stats
    // (bumpTools provides immediate feedback; this is the source-of-truth refresh)
    reporter?.refreshToolStats().catch(() => {});
  }, HEARTBEAT_MS);

  pi.on("session_shutdown", () => {
    if (watcherAc) watcherAc.abort();
    clearInterval(interval);
    clearInterval(heartbeat);
    clearInterval(cleanupInterval);
    // P3-19b: flush the latest dedup state (and any pending debounced save)
    // so a restart never re-pushes messages already handled.
    clearTimeout(dedupSaveTimer);
    persistDedupState(cfg, seen, notifiedAt);
  });

  poll();
}

// ── Manager console mode ──────────────────────────────────────────────

async function activateManagerConsole(pi: ExtensionAPI): Promise<void> {
  const gatewaySocket = process.env.AIMESHCHAT_GATEWAY_SOCKET ?? process.env.OMP_GATEWAY_SOCKET ?? `${homedir()}/.local/share/aimeshchat/gateway/control.sock`;
  if (!existsSync(gatewaySocket)) {
    console.warn(`[mailbox] manager console: gateway socket not found at ${gatewaySocket} — gateway may not be running`);
    return;
  }
  const client = new GatewayClient(gatewaySocket);
  let capturedCtx: ExtensionContext | undefined;
  try {
    pi.on("session_start", (_evt: unknown, ctx: ExtensionContext) => {
      capturedCtx = ctx;
    });
  } catch { /* hook unavailable */ }
  const render = () => {
    if (!capturedCtx || capturedCtx.hasUI === false) return;
    try {
      capturedCtx.ui.setStatus("gateway", "gateway connected");
    } catch { /* non-fatal */ }
  };
  try {
    const caps = await client.call("capabilities.get");
    console.warn(`[mailbox] manager console: gateway v${caps.version} runtimes=${JSON.stringify(caps.runtimes)}`);
    render();
  } catch (e) {
    console.warn(`[mailbox] manager console: gateway unreachable: ${(e as Error).message}`);
  }
  pi.on("session_shutdown", () => { /* manager console has no claims to release */ });
}

// ── Entry ─────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
  try {
    writeFileSync(`/tmp/omp-mb-load-${process.pid}.json`, JSON.stringify({
      pid: process.pid,
      identity_env: !!process.env.OMP_MAILBOX_IDENTITY_FILE,
      loaded_at: new Date().toISOString(),
    }));
  } catch { /* diagnostic only */ }

  // OMP 工厂只传 (api)；ExtensionContext 只能从事件 handler 捕获
  //（ExtensionHandler 签名 (event, ctx)）。manager console 在自身内部
  // 捕获；worker 路径在此捕获并传给 activate。
  let capturedCtx: ExtensionContext | undefined;
  try {
    pi.on("session_start", (_evt: unknown, ctx: ExtensionContext) => {
      capturedCtx = ctx;
    });
  } catch { /* hook unavailable */ }

  // Dual mode: launcher identity + CODEAGENT_ROLE=worker|oracle → runtime
  // adapter; otherwise (or CODEAGENT_ROLE=manager) → Manager console.
  const role = (process.env.CODEAGENT_ROLE ?? "").toLowerCase();
  const identityPath = process.env.OMP_MAILBOX_IDENTITY_FILE;
  const isWorker = !!identityPath && (role === "worker" || role === "oracle");

  if (!isWorker) {
    console.warn(`[mailbox] manager console mode (role=${role || "unset"})`);
    activateManagerConsole(pi).catch((e) => {
      console.error("[mailbox] manager console failed:", e);
    });
    return;
  }

  // Runtime adapter: poll for the launcher-written identity (2s), then activate.
  const idInterval = setInterval(() => {
    let identity: GatewayIdentity | null = null;
    try {
      identity = readIdentityFile(identityPath);
    } catch (e: unknown) {
      console.error("[mailbox] identity read error:", e);
      return;
    }
    if (!identity) return;
    clearInterval(idInterval);
    const cfg = buildConfig(identity.session_id, identity.agent_id);
    // ctx 未捕获（session_start 未触发）时传空对象——RuntimeEventReporter
    // 会降级为纯 gateway 事件上报（无 UI）。
    const effectiveCtx = (capturedCtx ?? {}) as ExtensionContext;
    // P1-11: activate 失败不清 interval，改为指数退避重试（5s→60s）。
    // checkMailboxCli 失败单独标记不阻断重试（见 activate 内部）。
    // P1-11: 退避重试定时器
    let retryTimer: Timer | null = null;
    let retryDelay = 5000; // P1-11: 初始退避 5s
    const RETRY_MAX_DELAY = 60_000; // P1-11: 最大退避 60s
    function tryActivate(): void {
      // identityPath! — isWorker guard (line above) already ensured non-undefined
      activate(pi, effectiveCtx, cfg, identityPath!).catch((e: unknown) => {
        console.error("[mailbox] activation failed, retrying in", retryDelay / 1000, "s:", e);
        retryTimer = setTimeout(() => {
          retryDelay = Math.min(retryDelay * 2, RETRY_MAX_DELAY);
          tryActivate();
        }, retryDelay);
      });
    }
    tryActivate();
    // session_shutdown 时清理重试定时器
    pi.on("session_shutdown", () => {
      if (retryTimer) clearTimeout(retryTimer);
    });
  }, IDENTITY_POLL_MS);

  pi.on("session_shutdown", () => {
    clearInterval(idInterval);
  });
}
