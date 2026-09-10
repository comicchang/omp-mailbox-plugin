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
export const MAX_NOTIFY_COUNT = 3;
export const MESSAGE_TTL_MS = 30 * 60 * 1000;
const MAILBOX_MIN_VERSION = "0.1.0";
const MAX_UI_ENTRIES = 50;
const UI_DEBOUNCE_MS = 500;
export const RETRY_NOTIFY_MS = 300_000; // A11.3: re-push interval for unclaimed messages (was 60s)
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
// Claim-2: auto-claimed messages stay in the store's processing area until a
// turn_start confirms the turn actually started. If no turn starts within
// this TTL (steer lost / agent died mid-dispatch), poll() releases the
// message back to the inbox instead of holding the claim silently.
// OMP_MAILBOX_PENDING_ACK_TTL_MS is a test seam only (default 120s).
const PENDING_ACK_TTL_MS = Number(process.env.OMP_MAILBOX_PENDING_ACK_TTL_MS ?? 120_000);

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

interface MailboxMessageSummary {
  from: string;
  kind: string;
  subject: string;
  msg_id: string;
  command_id?: string;
}

interface MailboxSummary {
  pending: number;
  messages: MailboxMessageSummary[];
}

interface OracleReplyMetadata {
  requestId: string;
  generation: string;
  replyTo: string;
}

interface MailboxMessageFile {
  body?: unknown;
  reply_to?: unknown;
  request_id?: unknown;
  generation?: unknown;
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
      } catch (e) {
        // EPERM = 进程存在但属于其它用户（Windows / 多用户）；只有 ESRCH 才是 owner 已死。
        if ((e as NodeJS.ErrnoException)?.code !== "EPERM") return null;
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
        // No owner_pid = explicitly long-lived identity (e.g. written by
        // `swarm attach` for hand-launched interactive peers). Never sweep —
        // the user manages its lifecycle manually.
        continue;
      }
      try {
        process.kill(pid, 0);
      } catch (e) {
        // Claim-2: EPERM = 进程存在但属于其它用户（Windows / 多用户）；
        // 只有 ESRCH 才是 owner 已死 — 与 readIdentityFile 的 EPERM 语义一致。
        if ((e as NodeJS.ErrnoException)?.code !== "EPERM") stale = true;
      }
    } catch { stale = true; } // corrupt/unreadable → stale
    if (stale) {
      try { unlinkSync(p); } catch { /* raced with another sweep — ignore */ }
    }
  }
}

// ── Dedup state persistence (P3-19b) ──────────────────────────────────

export interface NotificationStats {
  firstAt: number;
  lastAt: number;
  count: number;
}

export function shouldNotify(stats: NotificationStats | undefined, now: number): boolean {
  if (!stats) return true;
  if (stats.count >= MAX_NOTIFY_COUNT) return false;
  if (now - stats.firstAt >= MESSAGE_TTL_MS) return false;
  return now - stats.lastAt >= RETRY_NOTIFY_MS;
}

export function isNotificationExhausted(stats: NotificationStats, now: number): boolean {
  return stats.count >= MAX_NOTIFY_COUNT || now - stats.firstAt >= MESSAGE_TTL_MS;
}

/** Trim notifyStats to MAX_DEDUP_IDS, dropping exhausted budgets first so a
 *  FIFO eviction never resets a still-live message's wake budget. */
export function evictNotifyStats(notifyStats: Map<string, NotificationStats>, now: number): void {
  if (notifyStats.size <= MAX_DEDUP_IDS) return;
  for (const [id, stats] of notifyStats) {
    if (notifyStats.size <= MAX_DEDUP_IDS) break;
    if (isNotificationExhausted(stats, now)) notifyStats.delete(id);
  }
  while (notifyStats.size > MAX_DEDUP_IDS) notifyStats.delete(notifyStats.keys().next().value!);
}

function validNotificationStats(value: unknown): NotificationStats | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<NotificationStats>;
  if (
    typeof candidate.firstAt !== "number" ||
    !Number.isFinite(candidate.firstAt) ||
    typeof candidate.lastAt !== "number" ||
    !Number.isFinite(candidate.lastAt) ||
    typeof candidate.count !== "number" ||
    !Number.isInteger(candidate.count) ||
    candidate.count < 1
  ) {
    return undefined;
  }
  return {
    firstAt: candidate.firstAt,
    lastAt: candidate.lastAt,
    count: candidate.count,
  };
}

interface DedupState {
  seen: string[];
  notifyStats?: Record<string, NotificationStats>;
  /** Legacy msg_id → last notified epoch ms representation. */
  notifiedAt?: Record<string, number>;
  savedAt: number;
}
function loadDedupState(cfg: Config): { seen: Set<string>; notifyStats: Map<string, NotificationStats> } {
  const seen = new Set<string>();
  const notifyStats = new Map<string, NotificationStats>();
  try {
    const state = JSON.parse(readFileSync(dedupStatePath(cfg), "utf-8")) as Partial<DedupState>;
    if (Array.isArray(state.seen)) for (const id of state.seen) if (typeof id === "string") seen.add(id);
    if (state.notifyStats && typeof state.notifyStats === "object") {
      for (const [id, value] of Object.entries(state.notifyStats)) {
        const stats = validNotificationStats(value);
        if (stats) notifyStats.set(id, stats);
      }
    }
    // Migrate the previous msg_id → last timestamp format as one notification.
    if (state.notifiedAt && typeof state.notifiedAt === "object") {
      for (const [id, timestamp] of Object.entries(state.notifiedAt)) {
        if (notifyStats.has(id) || typeof timestamp !== "number" || !Number.isFinite(timestamp)) continue;
        notifyStats.set(id, { firstAt: timestamp, lastAt: timestamp, count: 1 });
      }
    }
  } catch { /* no state yet — fresh start */ }
  while (seen.size > MAX_DEDUP_IDS) seen.delete(seen.values().next().value!);
  evictNotifyStats(notifyStats, Date.now());
  return { seen, notifyStats };
}

function dedupStatePath(cfg: Config): string {
  return `${cfg.mailboxRoot}/${cfg.sessionId}/${cfg.agentId}/${DEDUP_STATE_FILE}`;
}


/** Persist dedup state (tmp + rename so a crash mid-write cannot corrupt). */
function persistDedupState(cfg: Config, seen: Set<string>, notifyStats: Map<string, NotificationStats>): void {
  try {
    const dir = `${cfg.mailboxRoot}/${cfg.sessionId}/${cfg.agentId}`;
    mkdirSync(dir, { recursive: true });
    const target = dedupStatePath(cfg);
    const tmp = `${target}.tmp`;
    const legacyNotifiedAt = Object.fromEntries(
      [...notifyStats].map(([id, stats]) => [id, stats.lastAt]),
    );
    writeFileSync(
      tmp,
      JSON.stringify({
        seen: [...seen],
        notifyStats: Object.fromEntries(notifyStats),
        notifiedAt: legacyNotifiedAt,
        savedAt: Date.now(),
      } satisfies DedupState),
    );
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

function readOracleReplyMetadata(cfg: Config, msgId: string): OracleReplyMetadata | null {
  try {
    const raw = readFileSync(join(cfg.inboxDir, `${msgId}.json`), "utf-8");
    const message = JSON.parse(raw) as MailboxMessageFile;
    let body: Record<string, unknown> = {};
    if (typeof message.body === "string") {
      try {
        const parsed = JSON.parse(message.body) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          body = parsed as Record<string, unknown>;
        }
      } catch { /* report body is opaque; metadata is taken from the envelope */ }
    }

    const requestId = typeof message.request_id === "string"
      ? message.request_id
      : typeof body.request_id === "string" ? body.request_id : "";
    const replyTo = typeof message.reply_to === "string"
      ? message.reply_to
      : typeof body.reply_to === "string" ? body.reply_to : "";
    if (!requestId || !replyTo) return null;

    const generationValue = message.generation
      ?? body.generation
      ?? process.env.OMP_MAILBOX_GENERATION;
    const generation = typeof generationValue === "number" && Number.isFinite(generationValue)
      ? String(generationValue)
      : typeof generationValue === "string" && generationValue.trim()
        ? generationValue
        : "unknown";
    const safe = (value: string, maxBytes: number): string =>
      truncateUtf8(value.replace(/[\u0000-\u001f\u007f]/g, " "), maxBytes);
    return {
      requestId: safe(requestId, 160),
      generation: safe(generation, 80),
      replyTo: safe(replyTo, 160),
    };
  } catch {
    // The peek result can race the atomic message write; retry on the next poll.
    return null;
  }
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
  const { seen, notifyStats } = loadDedupState(cfg);
  // P3-19b: debounced save whenever seen/notifyStats change; flushed
  // synchronously on session_shutdown so the latest state survives crashes.
  let dedupSaveTimer: Timer | undefined;
  const scheduleDedupSave = (): void => {
    clearTimeout(dedupSaveTimer);
    dedupSaveTimer = setTimeout(() => {
      dedupSaveTimer = undefined;
      persistDedupState(cfg, seen, notifyStats);
    }, DEDUP_SAVE_DEBOUNCE_MS);
  };

  // FC-2: park-revive + turn ack — 为每次 sendUserMessage 投递记录
  // command_id/msg_id/generation，turn_start 事件触发时向 Gateway 回报
  // TURN_TRIGGERED（关联 command 到实际 turn）。
  // P1-1: command_id（= Gateway 写 mailbox 时携带的 request_id）作为
  // runtime.command_ack 的 request_id 回传，命中命令表主键推进状态机。
  // 禁止把 sendUserMessage 未抛异常当成功——只有 Gateway 持久化 ack
  // 后才算 TURN_TRIGGERED。
  // read/claim（message.read: inbox→processing）在投递前，finalize 只在
  // turn_start 确认 turn 已启动后执行；投递失败与 TTL 兜底走 message.release
  // （processing→inbox）重投 —— 消息绝不无声滞留在 processing。
  // Claim-2: pending ack 按 msg_id 建条目 —— 一个 poll 可能 claim 多条
  // TASK，单槽（旧 "next" 键）会互相覆盖导致 ack/finalize 丢失。
  // 已知局限：OMP turn_start 不携带 turn 身份，drain 时无法精确区分
  // 是哪条 steer 触发的 turn；用户手动触发的 turn 与我们的 steer 竞争
  // 时会提前消费 ack 条目 —— 可接受：消息本就为投递而 claim，且 store
  // 层 finalize 幂等。turn_start 时逐条 finalize + TURN_TRIGGERED ack，
  // 每条各自 catch、互不阻塞、至多消费一次。
  interface PendingTurnAck {
    commandId: string;
    msgId: string;
    generation: number;
    /** claim（message.read）完成时刻，供 poll() 的 TTL 兜底释放使用。 */
    claimedAt: number;
  }
  const pendingTurnAck = new Map<string, PendingTurnAck>();
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
                // FC-2: 上报 capabilities（park_revive / correlated_turn_ack — 无 _v1 后缀，对齐 Gateway _is_hot 精确匹配）
                // 以便 Gateway 对 ended/parked agent 走 park-revive 投递链。
                // omp_agent_id / backend_session_id / generation 供 Gateway
                // 在投递时校验 binding_epoch 并关联 TURN_TRIGGERED。
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
                    // FC-2: 插件身份 + 能力声明
                    omp_agent_id: identity.agent_id,
                    capabilities: ["park_revive", "correlated_turn_ack"]  // 对齐 Gateway _is_hot 精确匹配：无 _v1 后缀,
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
            let ackKey = "";
            try {
                // FC-2: 初始任务也走 turn ack 链 — command_id 从 handshake 响应获取。
                const initialCmdId = (handshakeResult?.initial_task_command_id as string) ?? initialTaskMsgId;
                if (initialCmdId) {
                    // Claim-2: 按 msg_id 建条目；无 msg_id 时用 command_id 兜底键
                    //（该条目 msgId 为空，turn_start 不会对它 finalize/release）。
                    ackKey = initialTaskMsgId || `initial:${initialCmdId}`;
                    pendingTurnAck.set(ackKey, {
                        commandId: initialCmdId,
                        msgId: initialTaskMsgId,
                        generation: identity.generation,
                        claimedAt: Date.now(),
                    });
                }
                pi.sendUserMessage(initialTask, { deliverAs: "steer" });
                reporter.updateUi("initial task dispatched (park-revive)");
            } catch (e) {
                // FC-2: 清理失败 ack（键与 set 一致）
                if (ackKey) pendingTurnAck.delete(ackKey);
                console.error(`[mailbox] initial task dispatch failed: ${(e as Error).message}`);
            }
        }
        // Consume the delivered initial task (claim only) so a stale
        // unclaimed TASK is never re-delivered on the next warm resume.
        // claim 在此，finalize 由 turn_start handler 在 turn 确认后执行。
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
                    reporter.updateUi(`initial task ${claimedId.slice(0, 8)} claimed (finalize deferred to turn_start)`);
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
    ensureInboxPolling(); // FC-1: self-heal any torn-down inbox polling
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
  //
  // R5: getSessionId() may still be empty at session_start if the session
  // manager initializes asynchronously. Schedule retries (5 attempts, 2s apart)
  // so the gateway eventually gets the real backend_session_id.
  on("session_start", ((_evt: unknown, handlerCtx: ExtensionContext) => {
    ensureInboxPolling(); // FC-1: self-heal any torn-down inbox polling
    if (!identity?.gateway_socket) return;

    // R5: retry up to60 times (120s total) to cover the CLI's120s binding window.
    // Both getSessionId() empty AND RPC failure trigger retry.
    const MAX_RETRIES = 60;
    const RETRY_INTERVAL_MS = 2000;
    const tryRegister = (attempt: number) => {
      let backendSessionId = "";
      try {
        backendSessionId = handlerCtx?.sessionManager?.getSessionId?.() ?? "";
      } catch { /* not ready yet */ }
      if (backendSessionId) {
        capturedBackendSessionId = backendSessionId; // R4: 缓存供 heartbeat 恢复复用
        // FC-2: re-register 也带 capabilities（idempotent，Gateway 合并）
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
          omp_agent_id: identity.agent_id,
          capabilities: ["park_revive", "correlated_turn_ack"],
        }).catch((e) => {
          // R5: RPC failure also retries (gateway transient error)
          console.warn(`[mailbox] session_start re-register failed (attempt ${attempt + 1}): ${(e as Error).message}`);
          if (attempt + 1 < MAX_RETRIES) {
            setTimeout(() => tryRegister(attempt + 1), RETRY_INTERVAL_MS);
          }
        });
      } else if (attempt + 1 < MAX_RETRIES) {
        // R5: session manager not ready yet — retry after delay
        setTimeout(() => tryRegister(attempt + 1), RETRY_INTERVAL_MS);
      } else {
        console.warn("[mailbox] session_start: getSessionId() still empty after 60 retries (120s) — gateway binding will remain pending");
      }
    };
    tryRegister(0);
  }) as never);
  on("turn_start", () => {
    ensureInboxPolling(); // FC-1: self-heal any torn-down inbox polling
    // P1-1: turn ack 改走 runtime.command_ack —— Gateway 命令表主键是
    // request_id，mailbox 消息已带 command_id（= request_id），此处以
    // ack.commandId 作为 request_id 上报 TURN_TRIGGERED，直接推进命令
    // 状态机（跳级自动补齐 QUEUED→CLAIMED→REVIVING→TRIGGERING）。
    // 只在有 pending ack 时回报（正常 user turn 不触发 ack）。
    // Claim-2: 逐条 drain pending ack（Map 按 msg_id 建键，一个 poll 可能
    // claim 多条 TASK）。OMP turn_start 不携带 turn 身份，无法精确对应
    // 是哪条 steer 触发的 turn（已知局限见上方 Claim-2 注释：用户手动
    // 触发的 turn 可能提前消费 ack 条目，可接受）。每条至多消费一次：
    // 先删条目再异步回报，command_ack 与 finalize 各自 catch、互不阻塞。
    if (identity?.gateway_socket) {
      for (const [ackKey, ack] of pendingTurnAck) {
        pendingTurnAck.delete(ackKey);
        const turnAckClient = new GatewayClient(identity.gateway_socket);
        turnAckClient.call("runtime.command_ack", {
          request_id: ack.commandId, // = mailbox command_id = Gateway 命令表主键
          state: "TURN_TRIGGERED",
          runtime_id: identity.runtime_id,
          generation: identity.generation,
          turn_id: "", // OMP turn_start 不暴露 turn_id；Gateway 通过时间窗口关联
        }).catch((e) => {
          console.error(`[mailbox] TURN_TRIGGERED ack failed: ${(e as Error).message}`);
        });
        if (ack.msgId) {
          new GatewayClient(identity.gateway_socket).call("message.finalize", {
            session_id: identity.session_id,
            agent: identity.agent_id,
            msg_id: ack.msgId,
            owner: identity.agent_id,
          }).catch((e) => console.warn(
            `[mailbox] finalize after turn_start failed: ${(e as Error).message}`));
        }
      }
    }
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
    // FC-1: DO NOT tear down the inbox polling (watcher + interval) here.
    // A hot parked runtime (park=true oracle) survives session_shutdown —
    // the poll loop is its ONLY way to hear the next ask, so killing it
    // here strands steer messages and zombies the runtime. On a real exit
    // the timers/watchers die with the process; on a park transfer the
    // loop keeps running, and ensureInboxPolling() self-heals any genuine
    // teardown on the next session_start/agent_start/turn_start.
    // FC-2: 清理 pendingTurnAck — session_shutdown 表示当前 turn 已结束，
    // 未被 turn_start 消费的 ack 不应残留到下一轮。
    pendingTurnAck.clear();
    if (reporter) reporter.report("RUNTIME_STATE", { state: "session_shutdown" });
  });

  // ── model_change / thinking_level_change → runtime.context_set 上报 ──
  // Q5 §9: default 继承主 agent 当前模型。插件监听模型/思考级别变更，
  // 原子更新 gateway runtime.context（provider/model/variant/epoch）。
  // 若 gateway 不可达，静默降级，下个事件重试。
  let modelContextEpoch = 0;
  function reportModelContext(ctx: ExtensionContext, thinkingLevel?: string): void {
    if (!identity?.gateway_socket) return;
    try {
      const model = ctx.model;
      modelContextEpoch += 1;
      new GatewayClient(identity.gateway_socket).call("runtime.context_set", {
        runtime_id: identity.runtime_id,
        session_id: identity.session_id,
        agent_id: identity.agent_id,
        provider: model?.provider ?? "unknown",
        model: model?.id ?? "unknown",
        variant: model?.requestModelId ?? "",
        thinking_level: thinkingLevel ?? "default",
        epoch: modelContextEpoch,
        updated_at: new Date().toISOString(),
      }).catch((e) => {
        console.warn(`[mailbox] runtime.context_set failed (will retry on next event): ${(e as Error).message}`);
      });
    } catch (e) {
      console.warn(`[mailbox] reportModelContext error: ${(e as Error).message}`);
    }
  }
  // 模型变更事件：上报新 provider/model/variant + 递增 epoch
  on("model_changed", ((_evt: unknown, handlerCtx: ExtensionContext) => {
    reportModelContext(handlerCtx);
  }) as never);
  // 思考级别变更事件：上报新 thinking_level + 递增 epoch
  on("thinking_level_changed", ((evt: { thinkingLevel?: string }, handlerCtx: ExtensionContext) => {
    reportModelContext(handlerCtx, evt.thinkingLevel);
  }) as never);

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
      // Claim-2: TTL 兜底 —— auto-claim 后若 turn 一直未被 turn_start 确认
      // （steer 丢失 / agent 死在投递途中 / ack 条目被用户 turn 提前消费），
      // 条目会永远滞留。超过 TTL 的未消费条目 message.release 回 inbox
      // （processing→inbox）重新投递 —— 没有 turn 确认时，选择重投而非
      // 静默持有 claim。条目删除故每条只 warn 一次；重投受 notifyStats
      // 预算约束（A11.3 有界重推）。
      for (const [ackKey, ack] of pendingTurnAck) {
        if (Date.now() - ack.claimedAt <= PENDING_ACK_TTL_MS) continue;
        pendingTurnAck.delete(ackKey);
        if (ack.msgId && identity?.gateway_socket) {
          new GatewayClient(identity.gateway_socket).call("message.release", {
            session_id: identity.session_id,
            agent: identity.agent_id,
            msg_id: ack.msgId,
            owner: identity.agent_id,
          }).catch((e) => console.warn(
            `[mailbox] TTL release(${ack.msgId}) failed: ${(e as Error).message}`));
        }
        console.warn(`[mailbox] pending ack ${ackKey} expired without turn_start — released back to inbox`);
      }
      const result = await runPeek(cfg);
      if (!result) return; // peek 失败：保留上一次 widget 状态，不伪装成空 inbox
      if (reporter) reporter.setPending(result.pending);
      if (reporter) renderUi(ctx, reporter.snapshot());
      // A11.2: consumed messages → seen.add immediately (no 5s delay).
      // Messages no longer in peek (pending=0) have been claimed/finalized.
      // Runs before the empty-check so bookkeeping keeps up even when the
      // inbox just drained to zero.
      for (const [msgId] of notifyStats) {
        // Claim-2: pendingTurnAck 中的消息已被本进程 claim（inbox→processing），
        // 从 peek 消失属预期而非已消费 —— 绝不 seen.add（否则 TTL 兜底释放回
        // inbox 后会被去重永久吞掉，消息丢失）。其归宿由 turn_start 的
        // finalize 或 poll() 的 TTL 兜底 release 负责。
        if (pendingTurnAck.has(msgId)) continue;
        if (!result.messages.some((m) => m.msg_id === msgId)) {
          seen.add(msgId);
          notifyStats.delete(msgId);
          if (seen.size > MAX_DEDUP_IDS) seen.delete(seen.values().next().value!);
          scheduleDedupSave(); // P3-19b
        }
      }
      if (result.messages.length === 0) return;
      for (const msg of result.messages) {
        if (seen.has(msg.msg_id)) continue;
        const stats = notifyStats.get(msg.msg_id); // A11.3
        const firstPush = stats === undefined;
        // A11.3: second+ push waits RETRY_NOTIFY_MS and is bounded by
        // MAX_NOTIFY_COUNT / MESSAGE_TTL_MS.
        const now = Date.now();
        if (!shouldNotify(stats, now)) continue;
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
          // (e.g. oracle with restricted tools), auto read the message
          // (message.read: inbox→processing) and direct-deliver its body as
          // a user turn.
          // FC-2: 增加 park-revive + turn ack 链 — claim（message.read 把消息
          // 移入 processing，finalize 由 turn_start 确认 turn 已启动后执行）→
          // 设置 pendingTurnAck（command_id 来自消息或 Gateway response）→
          // sendUserMessage(deliverAs=steer) 唤醒 parked agent →
          // turn_start 事件触发 TURN_TRIGGERED ack + finalize。
          // 失败/兜底路径：sendUserMessage 抛出 → message.release 回 inbox +
          // 删除 ack 条目（notifyStats 预算约束下有界重推）；steer 已发出但
          // turn 一直未确认 → poll() 按 PENDING_ACK_TTL_MS 兜底 release 重投。
          if (identity?.gateway_socket && !agentHasClaimTool(pi) && msg.kind === "TASK") {
            let claimed = false; // Claim-2: message.read 成功后消息已 inbox→processing
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
              claimed = true; // Claim-2: 读成功 → 消息已移入 processing
              const claimedId = (read.message as { msg_id?: string } | null)?.msg_id ?? msg.msg_id;
              // FC-2: command_id 优先取消息自带字段（Gateway durable command），
              // 兜底取 message.read 返回的 command_id，最后 fallback 到 msg_id。
              const cmdId = msg.command_id
                ?? (read.message as { command_id?: string } | null)?.command_id
                ?? claimedId;
              // FC-2/Claim-2: 设置 pendingTurnAck（按 msg_id 建键 —— 旧单槽
              // "next" 会被多条 TASK 互相覆盖导致 ack/finalize 丢失）。
              // turn_start 事件将用它经 runtime.command_ack 回报
              // TURN_TRIGGERED 给 Gateway（request_id = cmdId = mailbox
              // command_id，对齐命令表主键）；claimedAt 供 poll() 的 TTL
              // 兜底释放使用。
              // 禁止把 sendUserMessage 未抛异常当成功——只有 turn_start
              // 确认 turn 已启动。
              pendingTurnAck.set(msg.msg_id, {
                commandId: cmdId,
                msgId: claimedId,
                generation: identity.generation,
                claimedAt: now,
              });
              // FC-2: deliverAs="steer" 用于 park-revive 唤醒 parked agent。
              // sendUserMessage 对 idle agent 启动 turn，对 streaming agent
              // 排队为 steer——两者都唤醒 ended/parked agent 进入新 turn。
              pi.sendUserMessage(body || msg.subject || msg.kind, { deliverAs: "steer" });
              notifyStats.set(msg.msg_id, stats
                ? { ...stats, lastAt: now, count: stats.count + 1 }
                : { firstAt: now, lastAt: now, count: 1 });
              evictNotifyStats(notifyStats, now);
              scheduleDedupSave(); // P3-19b
              if (reporter) reporter.updateUi(`auto-claimed ${msg.msg_id.slice(0, 8)} (park-revive)`);
            } catch (e) {
              // Claim-2: 投递失败处理 —— message.read 失败时消息仍在 inbox，
              // 无需 release；sendUserMessage 抛出时消息已移入 processing，
              // message.release 回 inbox（processing→inbox）+ 删除 pending
              // ack 条目。记录 notifyStats（有界重推预算）后下轮 poll 重试。
              if (claimed) {
                pendingTurnAck.delete(msg.msg_id);
                if (identity?.gateway_socket) {
                  new GatewayClient(identity.gateway_socket).call("message.release", {
                    session_id: cfg.sessionId,
                    agent: cfg.agentId,
                    msg_id: msg.msg_id,
                    owner: cfg.agentId,
                  }).catch((re) => console.warn(
                    `[mailbox] message.release(${msg.msg_id}) failed: ${(re as Error).message}`));
                }
                notifyStats.set(msg.msg_id, stats
                  ? { ...stats, lastAt: now, count: stats.count + 1 }
                  : { firstAt: now, lastAt: now, count: 1 });
                evictNotifyStats(notifyStats, now);
                scheduleDedupSave(); // P3-19b
              }
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
          const notifiedAt = Date.now();
          notifyStats.set(
            msg.msg_id,
            stats
              ? { ...stats, lastAt: notifiedAt, count: stats.count + 1 }
              : { firstAt: notifiedAt, lastAt: notifiedAt, count: 1 },
          );
          evictNotifyStats(notifyStats, notifiedAt);
          scheduleDedupSave(); // P3-19b
        } catch (e: unknown) {
          console.error("[mailbox] sendMessage failed, keeping msg for retry:", e);
          continue;
        }
      }
    } catch (e: unknown) { console.error("[mailbox] poll error:", e); } finally { polling = false; }
  }

  // FC-1: inbox polling (watcher + interval) is a parked oracle's lifeline —
  // it MUST survive session_shutdown (park transfer). Nothing clears the
  // interval on session_shutdown anymore (see both shutdown handlers); this
  // helper lazily (re)creates watcher + interval so a torn-down loop (older
  // shutdown path, watcher error) self-heals on the next lifecycle event.
  let inboxInterval: Timer | undefined;
  function ensureInboxPolling(): void {
    if (!watcherAc) watcherAc = setupWatcher(cfg.inboxDir, poll);
    if (!inboxInterval) {
      inboxInterval = setInterval(() => {
        poll();
        if (!watcherAc) watcherAc = setupWatcher(cfg.inboxDir, poll);
      }, POLL_MS);
    }
  }
  ensureInboxPolling();

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
          // FC-2: heartbeat re-register 也带 capabilities
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
            omp_agent_id: identity.agent_id,
            capabilities: ["park_revive", "correlated_turn_ack"]  // 对齐 Gateway _is_hot 精确匹配：无 _v1 后缀,
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
    // FC-1: never tear down the inbox polling here either — a park transfer
    // fires session_shutdown while the process stays alive, and the poll
    // loop is the parked oracle's only way to receive the next ask (steer).
    // heartbeat/cleanup keep their existing shutdown behavior; the poll
    // watcher + interval survive and self-heal via ensureInboxPolling().
    clearInterval(heartbeat);
    clearInterval(cleanupInterval);
    // P3-19b: flush the latest dedup state (and any pending debounced save)
    // so a restart never re-pushes messages already handled.
    clearTimeout(dedupSaveTimer);
    persistDedupState(cfg, seen, notifyStats);
  });

  poll();
}

export function startManagerReplyWatcher(
  pi: ExtensionAPI,
  cfg: Config,
): { poll: () => Promise<void>; stop: () => void } {
  let watcherAc: AbortController | null = null;
  let interval: Timer | undefined;
  let pollPromise: Promise<void> | null = null;
  let stopped = false;
  const { seen } = loadDedupState(cfg);

  const poll = async (): Promise<void> => {
    if (stopped) return;
    if (pollPromise) {
      await pollPromise;
      return;
    }
    pollPromise = (async () => {
      try {
        const result = await runPeek(cfg);
        if (!result || !Array.isArray(result.messages)) return;
        for (const msg of result.messages) {
          if (stopped || msg.kind.toUpperCase() !== "REPORT" || !msg.msg_id) continue;
          const metadata = readOracleReplyMetadata(cfg, msg.msg_id);
          if (!metadata) continue;
          // msg_id is the immutable message identity; request/generation are
          // part of the persisted correlation key so a later report cannot
          // masquerade as an earlier ask.
          const dedupKey = `${metadata.requestId}\u0000${metadata.generation}\u0000${msg.msg_id}`;
          if (seen.has(dedupKey)) continue;
          try {
            pi.sendMessage(
              {
                customType: "omp-mailbox",
                display: true,
                content: [
                  "📬 ORACLE REPLY AVAILABLE",
                  `Request: ${metadata.requestId}`,
                  `Generation: ${metadata.generation}`,
                  `Message: ${msg.msg_id}`,
                  `Reply to: ${metadata.replyTo}`,
                  `Subject: ${msg.subject}`,
                  'Run: aimeshchat oracle result "$KEY" to verify the latest ask.',
                ].join("\n"),
                details: {
                  from: msg.from,
                  kind: msg.kind,
                  subject: msg.subject,
                  request_id: metadata.requestId,
                  generation: metadata.generation,
                  msg_id: msg.msg_id,
                  reply_to: metadata.replyTo,
                },
              },
              { triggerTurn: true, deliverAs: "nextTurn" },
            );
            seen.add(dedupKey);
            if (seen.size > MAX_DEDUP_IDS) seen.delete(seen.values().next().value!);
            persistDedupState(cfg, seen, new Map());
          } catch (e: unknown) {
            console.error("[mailbox] manager reply notification failed, keeping report for retry:", e);
          }
        }
      } catch (e: unknown) {
        console.error("[mailbox] manager reply watcher error:", e);
      }
    })();
    try {
      await pollPromise;
    } finally {
      pollPromise = null;
    }
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(interval);
    interval = undefined;
    watcherAc?.abort();
    watcherAc = null;
    persistDedupState(cfg, seen, new Map());
  };

  const ensurePolling = (): void => {
    if (!watcherAc) {
      watcherAc = setupWatcher(cfg.inboxDir, () => { void poll(); });
    }
    if (!interval) {
      interval = setInterval(() => {
        void poll();
        if (!watcherAc) watcherAc = setupWatcher(cfg.inboxDir, () => { void poll(); });
      }, POLL_MS);
    }
  };
  ensurePolling();
  void poll();

  return { poll, stop };
}

// ── Manager console mode ──────────────────────────────────────────────

async function activateManagerConsole(pi: ExtensionAPI): Promise<void> {
  const managerSessionId = [
    process.env.OMP_MAILBOX_SESSION_ID,
    process.env.SWARM_SESSION_ID,
    process.env.OMP_SESSION_ID,
  ].map((value) => value?.trim() ?? "").find(Boolean) ?? "";
  const managerAgentId = process.env.OMP_MAILBOX_AGENT_ID?.trim() || "manager";
  const replyWatcher = managerSessionId
    ? startManagerReplyWatcher(pi, buildConfig(managerSessionId, managerAgentId))
    : undefined;
  if (managerSessionId) {
    console.warn(`[mailbox] manager reply watcher active (session=${managerSessionId} agent=${managerAgentId})`);
  } else {
    console.warn("[mailbox] manager reply watcher disabled: no mailbox session id configured");
  }

  let capturedCtx: ExtensionContext | undefined;
  try {
    pi.on("session_start", (_evt: unknown, ctx: ExtensionContext) => {
      capturedCtx = ctx;
    });
  } catch { /* hook unavailable */ }
  try {
    pi.on("session_shutdown", () => {
      replyWatcher?.stop();
    });
  } catch { /* hook unavailable */ }

  const gatewaySocket = process.env.AIMESHCHAT_GATEWAY_SOCKET ?? process.env.OMP_GATEWAY_SOCKET ?? `${homedir()}/.local/share/aimeshchat/gateway/control.sock`;
  if (!existsSync(gatewaySocket)) {
    console.warn(`[mailbox] manager console: gateway socket not found at ${gatewaySocket} — gateway may not be running`);
    return;
  }
  const client = new GatewayClient(gatewaySocket);
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

  let idPollFailures = 0;
  let lastIdWarnAt = 0;
  const ID_WARN_INTERVAL_MS = 30_000;
  // Runtime adapter: poll for the launcher-written identity (2s), then activate.
  const idInterval = setInterval(() => {
    let identity: GatewayIdentity | null = null;
    try {
      identity = readIdentityFile(identityPath);
    } catch (e: unknown) {
      console.error("[mailbox] identity read error:", e);
      return;
    }
    if (!identity) {
      idPollFailures += 1;
      if (Date.now() - lastIdWarnAt >= ID_WARN_INTERVAL_MS) {
        lastIdWarnAt = Date.now();
        console.warn(`[mailbox] still waiting for a valid identity at ${identityPath} (${idPollFailures} polls) — launcher may have died before writing it`);
      }
      return;
    }
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
