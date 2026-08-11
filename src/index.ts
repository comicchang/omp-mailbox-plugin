import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { readFileSync, existsSync, unlinkSync, writeFileSync, watch as fsWatch } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { homedir } from "node:os";

const POLL_MS = 30_000;
const IDENTITY_POLL_MS = 2_000;
const CHECK_TIMEOUT_MS = 5_000;
const GATEWAY_TIMEOUT_MS = 5_000;
const MAX_DEDUP_IDS = 100;
const MAILBOX_MIN_VERSION = "0.1.0";
const MAX_UI_ENTRIES = 50;
const UI_DEBOUNCE_MS = 500;
const RETRY_NOTIFY_MS = 300_000; // A11.3: re-push interval for unclaimed messages (was 60s)

/** Launcher identity (0600 file created by postmesh, read-only here). */
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
  const root = process.env.MAILBOX_ROOT ?? `${homedir()}/.local/share/postmesh/mailbox`;
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
    const proc = Bun.spawn(["postmesh", "--version"], { stdout: "pipe", stderr: "pipe", timeout: CHECK_TIMEOUT_MS });
    const out = await new Response(proc.stdout).text();
    const match = out.match(/(\d+\.\d+\.\d+)/);
    if (match && proc.exitCode === 0) {
      if (!versionGte(match[1], MAILBOX_MIN_VERSION)) {
        console.error(`[mailbox] postmesh version ${match[1]} < required ${MAILBOX_MIN_VERSION}. Please upgrade postmesh.`);
        throw new Error(`mailbox CLI version too old: ${match[1]} < ${MAILBOX_MIN_VERSION}`);
      }
      return;
    }
  } catch { /* fall through to existence check */ }

  try {
    const proc = Bun.spawn([cliPath, "--help"], { stdout: "pipe", stderr: "pipe", timeout: CHECK_TIMEOUT_MS });
    await proc.exited;
    if (proc.exitCode !== 0) {
      console.error(`[mailbox] CLI '${cliPath}' is not callable (exit ${proc.exitCode}). Is postmesh installed? (pipx install postmesh-py)`);
      throw new Error(`mailbox CLI not functional: ${cliPath}`);
    }
  } catch (e) {
    console.error(`[mailbox] CLI '${cliPath}' not found in PATH. Set MAILBOX_CLI or install postmesh (pipx install postmesh-py).`);
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

  report(kind: string, payload: Record<string, unknown>): void {
    if (!this.client) return;
    const evt = {
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
    this.client.call("runtime.event", { event: evt }).catch((e) => {
      console.error(`[mailbox] runtime.event failed: ${(e as Error).message}`);
    });
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

  await checkMailboxCli(cfg.cliPath);

  let watcherAc: AbortController | null = null;
  let polling = false;
  const seen = new Set<string>();
  const notifiedAt = new Map<string, number>(); // A11.3: per-msg_id last notification timestamp

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
                const read = await client.call("message.read", {
                    session_id: identity.session_id,
                    agent: identity.agent_id,
                    owner: identity.agent_id,
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
  on("session_start", () => {
    if (!identity?.gateway_socket) return;
    let backendSessionId = "";
    try {
      backendSessionId = ctx?.sessionManager?.getSessionId?.() ?? "";
    } catch { /* not ready yet */ }
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
  });
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
      reporter.report("TASK_STATE", { state: "agent_end" });
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
              const read = await claimClient.call("message.read", {
                session_id: cfg.sessionId,
                agent: cfg.agentId,
                owner: cfg.agentId,
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
        } catch (e: unknown) {
          console.error("[mailbox] sendMessage failed, keeping msg for retry:", e);
          continue;
        }
      }
    } catch (e: unknown) { console.error("[mailbox] poll error:", e); } finally { polling = false; }
  }

  watcherAc = setupWatcher(cfg.inboxDir, poll);
  const interval = setInterval(() => { poll(); if (!watcherAc) watcherAc = setupWatcher(cfg.inboxDir, poll); }, POLL_MS);

  // ── Heartbeat: keeps the gateway's last_activity fresh (hot liveness +
  //    park lease renew). The gateway treats any runtime.event as activity;
  //    the heartbeat guarantees a cadence even when idle. ────────────
  const HEARTBEAT_MS = 60_000;
  const heartbeat = setInterval(() => {
    if (!identity?.gateway_socket) return;
    new GatewayClient(identity.gateway_socket).call("runtime.heartbeat", {
      runtime_id: identity.runtime_id,
    }).catch(() => { /* gateway down — retry next tick */ });
    // A13: reconcile widget tool counter with gateway-aggregated tool_stats
    // (bumpTools provides immediate feedback; this is the source-of-truth refresh)
    reporter?.refreshToolStats().catch(() => {});
  }, HEARTBEAT_MS);

  pi.on("session_shutdown", () => {
    if (watcherAc) watcherAc.abort();
    clearInterval(interval);
    clearInterval(heartbeat);
  });

  poll();
}

// ── Manager console mode ──────────────────────────────────────────────

async function activateManagerConsole(pi: ExtensionAPI): Promise<void> {
  const gatewaySocket = process.env.POSTMESH_GATEWAY_SOCKET ?? process.env.OMP_GATEWAY_SOCKET ?? `${homedir()}/.local/share/postmesh/gateway/control.sock`;
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
    activate(pi, effectiveCtx, cfg, identityPath).catch((e: unknown) => {
      console.error("[mailbox] activation failed:", e);
    });
  }, IDENTITY_POLL_MS);

  pi.on("session_shutdown", () => {
    clearInterval(idInterval);
  });
}
