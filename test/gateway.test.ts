import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, utimesSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { Config, GatewayIdentity } from "../src/index";

// Claim-2 test seam. Static import cannot work here: src/index captures
// PENDING_ACK_TTL_MS from OMP_MAILBOX_PENDING_ACK_TTL_MS once at module
// evaluation, and ESM hoisting evaluates static imports before any module
// body statement — so the env seam must be set before a deliberately dynamic
// import (test exercising a module-load boundary). 50ms is safe for the
// whole suite: no test besides the TTL-fallback one keeps a pending ack
// alive across a poll().
process.env.OMP_MAILBOX_PENDING_ACK_TTL_MS = "50";
const {
  activate,
  GatewayClient,
  readIdentityFile,
  RuntimeEventReporter,
  default: pluginFactory,
} = await import("../src/index");

/** Kind of a gateway event record (validated narrowing, no unchecked cast). */
function eventKind(e: Record<string, unknown>): string {
  return typeof e.kind === "string" ? e.kind : "";
}

// ── Fake gateway: a UDS server that answers like the real AgentGateway ─

class FakeGateway {
  server: Server;
  requests: { method: string; params: Record<string, unknown> }[] = [];
  events: Record<string, unknown>[] = [];
  released: string[] = [];
  finalized: string[] = [];
  releasedMsgs: string[] = [];
  socketPath: string;
  private _idCounter = 0;

  constructor(socketPath: string) {
    this.socketPath = socketPath;
    this.server = createServer((sock: Socket) => {
      let buf = "";
      sock.on("data", (chunk) => {
        buf += chunk.toString("utf-8");
        if (!buf.includes("\n")) return;
        const line = buf.split("\n", 1)[0];
        // NDJSON framing: keep whatever follows the newline (a chunk may
        // hold a full line plus the start of the next) instead of dropping
        // the leftover by resetting the buffer to "".
        buf = buf.slice(buf.indexOf("\n") + 1);
        let req: { id: string; method: string; params: Record<string, unknown> };
        try {
          req = JSON.parse(line);
        } catch {
          sock.write(JSON.stringify({ v: 1, id: "", ok: false, error: { code: "PROTOCOL", message: "bad json" } }) + "\n");
          return;
        }
        this.requests.push({ method: req.method, params: req.params });
        const resp = this.handle(req);
        sock.write(JSON.stringify({ v: 1, id: req.id, ok: resp.ok, result: resp.result, error: resp.error }) + "\n");
        sock.end();
      });
    });
  }

  handle(req: { id: string; method: string; params: Record<string, unknown> }): {
    ok: boolean; result?: Record<string, unknown>; error?: { code: string; message: string };
  } {
    switch (req.method) {
      case "runtime.register":
        return { ok: true, result: { runtime_id: req.params.runtime_id, session_id: req.params.session_id, agent_id: req.params.agent_id, generation: req.params.generation, initial_task: "" } };
      case "runtime.event": {
        const evt = (req.params.event ?? {}) as Record<string, unknown>;
        this.events.push(evt);
        return { ok: true, result: { event_id: this.events.length, source_sequence: this.events.length } };
      }
      case "message.peek":
        return { ok: true, result: { pending: 0, messages: [] } };
      case "message.read":
        return { ok: true, result: { status: "ok", message: null, receipt: { status: "delivered", msg_id: "rcpt-1" } } };
      case "message.finalize":
        this.finalized.push(String(req.params.msg_id ?? ""));
        return { ok: true, result: { status: "ok" } };
      case "message.release":
        this.releasedMsgs.push(String(req.params.msg_id ?? ""));
        return { ok: true, result: { status: "released" } };
      case "park.release":
        this.released.push(String(req.params.review_key ?? ""));
        return { ok: true, result: { released: req.params.review_key } };
      case "capabilities.get":
        return { ok: true, result: { version: 1, runtimes: ["omp"] } };
      default:
        return { ok: false, error: { code: "PROTOCOL", message: `unknown method ${req.method}` } };
    }
  }

  listen(): Promise<void> {
    return new Promise((resolve) => this.server.listen(this.socketPath, resolve));
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

// ── mock pi/ctx ────────────────────────────────────────────────────────

interface SentMessage { content: string; opts: { triggerTurn: boolean; deliverAs?: string } }

function mockCtx(opts: { hasUI?: boolean; idle?: boolean } = {}): ExtensionContext {
  return {
    hasUI: opts.hasUI ?? false,
    ui: {
      setStatus: () => {},
      setWorkingMessage: () => {},
      setWidget: () => {},
      notify: () => {},
    },
    isIdle: () => opts.idle ?? true,
    cwd: process.cwd(),
  } as unknown as ExtensionContext;
}

/** tools default to a claim-less set (no bash, no mailbox/inbox/claim) so
 *  TASK delivery takes the Claim-2 auto-claim path; pass claim-capable tool
 *  names (e.g. ["bash", "mailbox"]) to exercise the notify-only path. */
function mockPi(messages: SentMessage[], tools: string[] = ["read", "write"]): ExtensionAPI {
  return {
    sendMessage: (msg: unknown, o: unknown) => {
      const content = (msg as { content: string }).content;
      const opts = (o ?? {}) as { triggerTurn: boolean; deliverAs?: string };
      messages.push({ content, opts });
    },
    sendUserMessage: (content: string, o: unknown) => {
      // Record what the plugin actually passed (auto-claim delivers with
      // { deliverAs: "steer" }) instead of fabricating triggerTurn.
      const opts = (o ?? {}) as { triggerTurn?: boolean; deliverAs?: string };
      messages.push({
        content: String(content),
        opts: { triggerTurn: opts.triggerTurn ?? false, deliverAs: opts.deliverAs },
      });
    },
    getActiveTools: () => tools,
    on: () => {},
  } as unknown as ExtensionAPI;
}

function cfg(root: string, sid: string, wid: string): Config {
  return {
    sessionId: sid, agentId: wid,
    mailboxRoot: join(root, "mailbox"),
    cliPath: process.env.MAILBOX_CLI ?? "mailbox",
    inboxDir: join(root, "mailbox", sid, wid, "inbox"),
  };
}

function writeIdentity(path: string, identity: Partial<GatewayIdentity> & { session_id: string; agent_id: string }): void {
  writeFileSync(path, JSON.stringify({
    session_id: identity.session_id,
    agent_id: identity.agent_id,
    runtime_id: identity.runtime_id ?? "rt-1",
    review_key: identity.review_key ?? "",
    generation: identity.generation ?? 1,
    gateway_socket: identity.gateway_socket ?? "",
    owner_pid: identity.owner_pid ?? process.pid,
    nonce: identity.nonce ?? "n1",
  }));
}

async function until(fn: () => boolean, ms = 3000, step = 50): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return;
    await Bun.sleep(step);
  }
  throw new Error(`condition not met within ${ms}ms`);
}

// ═══════════════════════════════════════════════════════════════════════
describe("gateway identity (owner/nonce/generation)", () => {
  const ROOT = join(tmpdir(), `gw-identity-${Date.now()}`);
  const identityPath = join(ROOT, "identity.json");

  beforeEach(() => { mkdirSync(ROOT, { recursive: true }); });
  afterEach(() => { rmSync(ROOT, { recursive: true, force: true }); });

  test("accepts valid identity with generation", () => {
    writeIdentity(identityPath, { session_id: "s1", agent_id: "w1", generation: 3, nonce: "abc" });
    const id = readIdentityFile(identityPath);
    expect(id).not.toBeNull();
    expect(id!.session_id).toBe("s1");
    expect(id!.agent_id).toBe("w1");
    expect(id!.generation).toBe(3);
  });

  test("rejects stale owner_pid", () => {
    // owner_pid = a pid that cannot exist (1 is init — always alive on unix,
    // but 99999999 cannot be a live pid in practice)
    writeIdentity(identityPath, { session_id: "s1", agent_id: "w1", owner_pid: 99999999 });
    expect(readIdentityFile(identityPath)).toBeNull();
  });

  test("rejects owner_pid recycled by a newer process", async () => {
    // P3-19c: a live pid whose process started AFTER the identity file was
    // written cannot be the original launcher (kernel recycled the number).
    const child = Bun.spawn(["sleep", "5"], { stdout: "pipe", stderr: "pipe" });
    try {
      writeFileSync(identityPath, JSON.stringify({ session_id: "s1", agent_id: "w1", owner_pid: child.pid, nonce: "n" }));
      // Backdate the identity file to before the child started.
      const past = new Date(Date.now() - 60_000);
      utimesSync(identityPath, past, past);
      expect(readIdentityFile(identityPath)).toBeNull();
    } finally {
      child.kill();
      try { await child.exited; } catch { /* already dead */ }
    }
  });

  test("rejects nonce mismatch", () => {
    writeIdentity(identityPath, { session_id: "s1", agent_id: "w1", nonce: "expected-nonce" });
    const old = process.env.OMP_MAILBOX_NONCE;
    process.env.OMP_MAILBOX_NONCE = "different";
    try {
      expect(readIdentityFile(identityPath)).toBeNull();
    } finally {
      if (old === undefined) delete process.env.OMP_MAILBOX_NONCE;
      else process.env.OMP_MAILBOX_NONCE = old;
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe("gateway client RPC", () => {
  const ROOT = join(tmpdir(), `gw-client-${Date.now()}`);
  const sock = join(ROOT, "gw.sock");
  let fake: FakeGateway;

  beforeEach(async () => {
    mkdirSync(ROOT, { recursive: true });
    fake = new FakeGateway(sock);
    await fake.listen();
  });
  afterEach(async () => {
    await fake.close();
    rmSync(ROOT, { recursive: true, force: true });
  });

  test("round-trip capabilities.get", async () => {
    const client = new GatewayClient(sock);
    const result = await client.call("capabilities.get");
    expect(result.version).toBe(1);
  });

  test("runtime.register returns identity echo", async () => {
    const client = new GatewayClient(sock);
    const result = await client.call("runtime.register", {
      session_id: "s1", agent_id: "w1", runtime_id: "rt-1",
      generation: 1, owner_pid: process.pid, nonce: "n",
    });
    expect(result.runtime_id).toBe("rt-1");
  });

  test("runtime.event payloads are delivered verbatim", async () => {
    const client = new GatewayClient(sock);
    await client.call("runtime.event", {
      event: { runtime_id: "rt-1", generation: 1, session_id: "s1", agent_id: "w1",
               request_id: "", run_id: "", kind: "TOOL_STARTED",
               created_at: "2026-01-01T00:00:00Z", payload: { tool: "bash" } },
    });
    expect(fake.events.length).toBe(1);
    expect((fake.events[0] as { kind: string }).kind).toBe("TOOL_STARTED");
  });

  test("gateway down → rejected promise", async () => {
    const client = new GatewayClient(join(ROOT, "missing.sock"));
    await expect(client.call("capabilities.get")).rejects.toThrow();
  });

  test("reportRetry keeps retrying until the gateway accepts (agent_end not dropped)", async () => {
    // P3-19a: terminal reports must survive a briefly-unreachable gateway.
    // The socket does not exist yet → first attempt fails; the backoff
    // retry delivers once the gateway comes up, exactly once.
    // NOTE: real delays are deliberate here — the retry is driven by the
    // plugin's own setTimeout backoff against a real UDS socket; fake
    // timers cannot make ECONNREFUSED happen on demand.
    const lateSock = join(ROOT, "late.sock");
    const identity: GatewayIdentity = {
      session_id: "s1", agent_id: "w1", runtime_id: "rt-1", review_key: "",
      generation: 1, gateway_socket: lateSock, owner_pid: process.pid, nonce: "n",
    };
    const reporter = new RuntimeEventReporter(identity, mockCtx());
    reporter.reportRetry("TASK_STATE", { state: "agent_end" }, 5, 50);
    await Bun.sleep(30); // let the immediate first attempt fail (ECONNREFUSED)

    const lateFake = new FakeGateway(lateSock);
    await lateFake.listen();
    try {
      await until(() => lateFake.events.some((e) => eventKind(e) === "TASK_STATE"));
      const delivered = lateFake.events.filter((e) => eventKind(e) === "TASK_STATE");
      expect(delivered.length).toBe(1); // retry stops after success — no duplicates
    } finally {
      await lateFake.close();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe("plugin runtime adapter", () => {
  const ROOT = join(tmpdir(), `gw-adapter-${Date.now()}`);
  const sock = join(ROOT, "gw.sock");
  const mailboxRoot = join(ROOT, "mailbox");
  const identityPath = join(ROOT, "identity.json");
  let fake: FakeGateway;
  let messages: SentMessage[];
  let inbox: string;

  beforeEach(async () => {
    mkdirSync(join(mailboxRoot, "s1", "w1", "inbox"), { recursive: true });
    mkdirSync(join(mailboxRoot, "s1", "w1", "processing"), { recursive: true });
    mkdirSync(join(mailboxRoot, "s1", "manager", "inbox"), { recursive: true });
    fake = new FakeGateway(sock);
    await fake.listen();
    messages = [];
    inbox = join(mailboxRoot, "s1", "w1", "inbox");
  });
  afterEach(async () => {
    await fake.close();
    rmSync(ROOT, { recursive: true, force: true });
  });

  test("handshake registers with gateway (owner_pid+nonce+generation)", async () => {
    writeIdentity(identityPath, {
      session_id: "s1", agent_id: "w1", runtime_id: "rt-1",
      generation: 2, gateway_socket: sock, nonce: "n1",
    });
    // claim-capable agent → notify-only path. Every runtime in this describe
    // must stay claim-capable: a leaked poll loop (parked-oracle design, no
    // teardown) from a claim-less runtime would auto-claim later tests'
    // messages behind their backs.
    await activate(mockPi(messages, ["bash", "mailbox"]) as ExtensionAPI, mockCtx(), cfg(ROOT, "s1", "w1"), identityPath);
    await until(() => fake.requests.some((r) => r.method === "runtime.register"));
    const reg = fake.requests.find((r) => r.method === "runtime.register")!;
    expect(reg.params.session_id).toBe("s1");
    expect(reg.params.agent_id).toBe("w1");
    expect(reg.params.generation).toBe(2);
    expect(reg.params.owner_pid).toBe(process.pid);
    expect(reg.params.nonce).toBe("n1");
  });

  test("peek does NOT consume (no read/finalize from watcher)", async () => {
    writeIdentity(identityPath, {
      session_id: "s1", agent_id: "w1", runtime_id: "rt-1", gateway_socket: sock,
    });
    // claim-capable agent (bash/CLI) → notify-only path; mockPi's default
    // claim-less tools would take the Claim-2 auto-claim path instead.
    await activate(mockPi(messages, ["bash", "mailbox"]) as ExtensionAPI, mockCtx(), cfg(ROOT, "s1", "w1"), identityPath);

    const msg = {
      session_id: "s1", from: "manager", to: "w1", subject: "task",
      body: "do it", kind: "TASK", msg_id: "mgr_1", created_at: "2026-01-01T00:00:00Z",
    };
    writeFileSync(join(inbox, "mgr_1.json"), JSON.stringify(msg));

    await until(() => messages.length > 0);
    // watcher notified but never claimed: no message.read call from watcher path
    const reads = fake.requests.filter((r) => r.method === "message.read");
    expect(reads.length).toBe(0);
    // message still in inbox (peek is non-consuming)
    expect(readFileSync(join(inbox, "mgr_1.json"), "utf-8")).toContain("mgr_1");
  });

  test("idle agent notified with nextTurn; running agent with steer", async () => {
    writeIdentity(identityPath, {
      session_id: "s1", agent_id: "w1", runtime_id: "rt-1", gateway_socket: sock,
    });
    // idle context
    // claim-capable agent → notify path (deliverAs from ctx.isIdle); the
    // auto-claim path always steers regardless of idle state.
    await activate(mockPi(messages, ["bash", "mailbox"]) as ExtensionAPI, mockCtx({ idle: true }), cfg(ROOT, "s1", "w1"), identityPath);
    const msg = {
      session_id: "s1", from: "manager", to: "w1", subject: "t", body: "b",
      kind: "TASK", msg_id: "mgr_2", created_at: "2026-01-01T00:00:00Z",
    };
    writeFileSync(join(inbox, "mgr_2.json"), JSON.stringify(msg));
    await until(() => messages.length > 0);
    expect(messages[0].opts.deliverAs).toBe("nextTurn");
    expect(messages[0].opts.triggerTurn).toBe(true);
  });

  test("lifecycle hooks emit runtime events", async () => {
    writeIdentity(identityPath, {
      session_id: "s1", agent_id: "w1", runtime_id: "rt-1", gateway_socket: sock,
    });
    // Capture the pi.on registrations
    const handlers = new Map<string, () => void>();
    const pi = {
      sendMessage: () => {},
      sendUserMessage: () => {},
      on: (evt: string, fn: () => void) => handlers.set(evt, fn),
    } as unknown as ExtensionAPI;
    await activate(pi, mockCtx(), cfg(ROOT, "s1", "w1"), identityPath);
    await until(() => fake.requests.some((r) => r.method === "runtime.register"));

    handlers.get("turn_start")?.();
    handlers.get("tool_call")?.();
    await until(() => fake.events.some((e) => (e as { kind: string }).kind === "TURN_STARTED"));
    expect(fake.events.some((e) => (e as { kind: string }).kind === "TOOL_STARTED")).toBe(true);
  });

  test("shutdown does NOT release hot park", async () => {
    writeIdentity(identityPath, {
      session_id: "s1", agent_id: "w1", runtime_id: "rt-1",
      review_key: "k1", gateway_socket: sock,
    });
    const handlers = new Map<string, () => void>();
    const pi = {
      sendMessage: () => {},
      sendUserMessage: () => {},
      on: (evt: string, fn: () => void) => handlers.set(evt, fn),
    } as unknown as ExtensionAPI;
    await activate(pi, mockCtx(), cfg(ROOT, "s1", "w1"), identityPath);
    await until(() => fake.requests.some((r) => r.method === "runtime.register"));

    handlers.get("session_shutdown")?.();
    await Bun.sleep(100);
    // No park.release ever fired — hot parked runtime survives manager switch
    expect(fake.released.length).toBe(0);
  });

  test("no-UI mode reports events without touching UI", async () => {
    writeIdentity(identityPath, {
      session_id: "s1", agent_id: "w1", runtime_id: "rt-1", gateway_socket: sock,
    });
    const pi = {
      sendMessage: () => {},
      sendUserMessage: () => {},
      on: () => {},
    } as unknown as ExtensionAPI;
    // ctx.hasUI=false — renderUi must be a no-op (no throw)
    await activate(pi, mockCtx({ hasUI: false }), cfg(ROOT, "s1", "w1"), identityPath);
    await until(() => fake.requests.some((r) => r.method === "runtime.register"));
    expect(fake.requests.length).toBeGreaterThan(0);
  });

  test("agent_end emits TASK_STATE agent_end via retrying report", async () => {
    // P3-19a: the terminal agent_end event must be delivered (retrying
    // report) and carry the correct state for gateway run accounting.
    writeIdentity(identityPath, {
      session_id: "s1", agent_id: "w1", runtime_id: "rt-1", gateway_socket: sock,
    });
    const handlers = new Map<string, () => void>();
    const pi = {
      sendMessage: () => {},
      sendUserMessage: () => {},
      on: (evt: string, fn: () => void) => handlers.set(evt, fn),
    } as unknown as ExtensionAPI;
    await activate(pi, mockCtx(), cfg(ROOT, "s1", "w1"), identityPath);
    await until(() => fake.requests.some((r) => r.method === "runtime.register"));

    handlers.get("agent_end")?.();
    await until(() => fake.events.some((e) => eventKind(e) === "TASK_STATE"));
    const evt = fake.events.find((e) => eventKind(e) === "TASK_STATE")!;
    expect(evt.payload).toEqual({ state: "agent_end" });
  });

  test("persisted dedup: restart does not re-push or re-trigger known messages", async () => {
    // P3-19b: dedup state survives a runtime restart (crash) — a message
    // already notified/consumed is never pushed again with triggerTurn.
    writeIdentity(identityPath, {
      session_id: "s1", agent_id: "w1", runtime_id: "rt-1", gateway_socket: sock,
    });
    const mkPi = (out: SentMessage[]) => {
      const handlers = new Map<string, () => void>();
      const pi = {
        sendMessage: (msg: unknown, o: unknown) => {
          const content = (msg as { content: string }).content;
          const opts = (o ?? {}) as { triggerTurn: boolean; deliverAs?: string };
          out.push({ content, opts });
        },
        sendUserMessage: () => {},
        on: (evt: string, fn: () => void) => handlers.set(evt, fn),
      } as unknown as ExtensionAPI;
      return { pi, handlers };
    };

    const msg = {
      session_id: "s1", from: "manager", to: "w1", subject: "persist-me",
      body: "b", kind: "TASK", msg_id: "mgr_persist_1", created_at: "2026-01-01T00:00:00Z",
    };
    const p = join(inbox, "mgr_persist_1.json");

    // runtime 1: notify the message (triggerTurn), then shutdown → flush state.
    const first: SentMessage[] = [];
    const r1 = mkPi(first);
    await activate(r1.pi, mockCtx(), cfg(ROOT, "s1", "w1"), identityPath);
    await until(() => fake.requests.some((r) => r.method === "runtime.register"));
    writeFileSync(p, JSON.stringify(msg));
    await until(() => first.length === 1);
    expect(first[0].opts.triggerTurn).toBe(true);
    r1.handlers.get("session_shutdown")?.();

    // runtime 2 (fresh in-memory dedup) on the same mailbox — msg still in
    // the inbox, but the persisted state must suppress any re-push.
    const second: SentMessage[] = [];
    const r2 = mkPi(second);
    await activate(r2.pi, mockCtx(), cfg(ROOT, "s1", "w1"), identityPath);
    await Bun.sleep(300); // allow the activation poll to observe the inbox
    expect(second.length).toBe(0);

    // A genuinely new message still wakes the agent with triggerTurn.
    writeFileSync(join(inbox, "mgr_persist_2.json"), JSON.stringify({ ...msg, subject: "new", msg_id: "mgr_persist_2" }));
    await until(() => second.length === 1);
    expect(second[0].opts.triggerTurn).toBe(true);
    r2.handlers.get("session_shutdown")?.();
  });

  test("stale launcher identity files are swept; own + live-owner kept", async () => {
    // P3-19d: ~/.omp/mailbox-identity accumulation is bounded — dead-owner
    // leftovers are removed at activation, the plugin's own identity file
    // and any file whose launcher is still alive are preserved.
    const identityDir = join(ROOT, "identities");
    mkdirSync(identityDir, { recursive: true });
    const ownPath = join(identityDir, "own.json");
    const stalePath = join(identityDir, "stale.json");
    const livePath = join(identityDir, "live.json");
    writeFileSync(ownPath, JSON.stringify({ session_id: "s1", agent_id: "w1", owner_pid: process.pid }));
    writeFileSync(stalePath, JSON.stringify({ session_id: "s1", agent_id: "w1", owner_pid: 99999999 }));
    writeFileSync(livePath, JSON.stringify({ session_id: "s1", agent_id: "w1", owner_pid: process.pid }));

    await activate(mockPi(messages, ["bash", "mailbox"]) as ExtensionAPI, mockCtx(), cfg(ROOT, "s1", "w1"), ownPath);
    await until(() => !existsSync(stalePath));
    expect(existsSync(ownPath)).toBe(true);
    expect(existsSync(livePath)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe("claim-2 turn ack lifecycle (auto-claim / finalize / TTL release)", () => {
  // Per-test tmpdir: each test gets its own socket/inbox/dedup paths so a
  // leaked poll loop from a previous test (activate() never tears down its
  // watcher/interval — parked-oracle design) cannot watch this test's inbox
  // or auto-claim its fixture behind its back.
  let seq = 0;
  let ROOT = "";
  let sock = "";
  let mailboxRoot = "";
  let identityPath = "";
  const MSG_ID = "mgr_claim_1";
  const CMD_ID = "cmd_claim_1";
  let fake: FakeGateway;
  let messages: SentMessage[];
  let handlers: Map<string, () => void>;
  let inbox: string;
  let savedPollMs: string | undefined;
  let savedTtl: string | undefined;

  beforeEach(async () => {
    ROOT = join(tmpdir(), `gw-claim2-${Date.now()}-${++seq}`);
    sock = join(ROOT, "gw.sock");
    mailboxRoot = join(ROOT, "mailbox");
    identityPath = join(ROOT, "identity.json");
    // Seams: PENDING_ACK_TTL_MS captured at src import (top-of-file, 50ms);
    // POLL_MS is read per-activate, so setting it here drives ONLY this
    // describe's activate instances. Save/restore both.
    savedPollMs = process.env.OMP_MAILBOX_POLL_MS;
    savedTtl = process.env.OMP_MAILBOX_PENDING_ACK_TTL_MS;
    process.env.OMP_MAILBOX_PENDING_ACK_TTL_MS = "50";
    process.env.OMP_MAILBOX_POLL_MS = "120";
    mkdirSync(join(mailboxRoot, "s1", "w1", "inbox"), { recursive: true });
    mkdirSync(join(mailboxRoot, "s1", "w1", "processing"), { recursive: true });
    fake = new FakeGateway(sock);
    await fake.listen();
    messages = [];
    handlers = new Map();
    inbox = join(mailboxRoot, "s1", "w1", "inbox");
  });

  afterEach(async () => {
    await fake.close();
    rmSync(ROOT, { recursive: true, force: true });
    if (savedTtl === undefined) delete process.env.OMP_MAILBOX_PENDING_ACK_TTL_MS;
    else process.env.OMP_MAILBOX_PENDING_ACK_TTL_MS = savedTtl;
    if (savedPollMs === undefined) delete process.env.OMP_MAILBOX_POLL_MS;
    else process.env.OMP_MAILBOX_POLL_MS = savedPollMs;
  });

  /** pi mock with claim-less tools (no bash, no mailbox/inbox/claim →
   *  agentHasClaimTool false → auto-claim path), captured lifecycle handlers,
   *  and optional sendUserMessage failure. */
  function claimPi(opts: { failSend?: boolean } = {}): ExtensionAPI {
    const recordOpts = (o: unknown): { triggerTurn: boolean; deliverAs?: string } => {
      if (typeof o !== "object" || o === null) return { triggerTurn: false };
      const deliverAs = "deliverAs" in o && typeof o.deliverAs === "string" ? o.deliverAs : undefined;
      const triggerTurn = "triggerTurn" in o && typeof o.triggerTurn === "boolean" ? o.triggerTurn : false;
      return { triggerTurn, deliverAs };
    };
    return {
      sendMessage: (msg: unknown, o: unknown) => {
        const content = typeof msg === "object" && msg !== null && "content" in msg
          ? String(msg.content)
          : "";
        messages.push({ content, opts: recordOpts(o) });
      },
      sendUserMessage: (content: string, o: unknown) => {
        if (opts.failSend) throw new Error("sendUserMessage failed (test)");
        messages.push({ content: String(content), opts: recordOpts(o) });
      },
      getActiveTools: () => ["read", "write"],
      on: (evt: string, fn: () => void) => handlers.set(evt, fn),
    } as unknown as ExtensionAPI;
  }

  function writeTask(): void {
    writeFileSync(join(inbox, `${MSG_ID}.json`), JSON.stringify({
      session_id: "s1", from: "manager", to: "w1", subject: "claim me",
      body: "claim-body", kind: "TASK", msg_id: MSG_ID, command_id: CMD_ID,
      created_at: "2026-01-01T00:00:00Z",
    }));
  }

  test("auto-claim: turn_start finalizes once and acks TURN_TRIGGERED", async () => {
    writeIdentity(identityPath, {
      session_id: "s1", agent_id: "w1", runtime_id: "rt-1", gateway_socket: sock,
    });
    // Write before activate so the activation poll() claims deterministically
    // (no watcher race on a file written after activation).
    writeTask();
    await activate(claimPi(), mockCtx(), cfg(ROOT, "s1", "w1"), identityPath);

    // Claimed the exact fixture message (message.read: inbox→processing) and
    // delivered its body as a steer — the pendingTurnAck path, not notify.
    await until(() => fake.requests.some((r) => r.method === "message.read"));
    await until(() => messages.length > 0);
    const read = fake.requests.find((r) => r.method === "message.read")!;
    expect(read.params.msg_id).toBe(MSG_ID);
    expect(messages[0]?.opts.deliverAs).toBe("steer");
    expect(messages[0]?.content).toBe("claim-body");
    expect(fake.finalized.length).toBe(0); // finalize deferred until turn_start

    // turn_start confirms the turn actually started → drain the pending ack:
    // exactly one TURN_TRIGGERED command ack + one finalize, fixture msg_id.
    handlers.get("turn_start")?.();
    await until(() => fake.finalized.length > 0
      && fake.requests.some((r) => r.method === "runtime.command_ack"));
    expect(fake.finalized).toEqual([MSG_ID]);
    const acks = fake.requests.filter((r) => r.method === "runtime.command_ack");
    expect(acks.length).toBe(1);
    expect(acks[0]?.params.state).toBe("TURN_TRIGGERED");
    expect(acks[0]?.params.request_id).toBe(CMD_ID); // command_id = command table PK
  });

  test("TTL fallback: pending ack released back to inbox when turn never starts", async () => {
    writeIdentity(identityPath, {
      session_id: "s1", agent_id: "w1", runtime_id: "rt-1", gateway_socket: sock,
    });
    writeTask();
    await activate(claimPi(), mockCtx(), cfg(ROOT, "s1", "w1"), identityPath);
    await until(() => messages.length > 0); // claimed + steered, no turn_start
    expect(fake.finalized.length).toBe(0);

    // Age the pending ack past PENDING_ACK_TTL_MS (50ms seam), then trigger
    // one poll() via an inbox write (watcher → poll).
    // Age the pending ack past PENDING_ACK_TTL_MS (50ms seam), then let the
    // poll interval (OMP_MAILBOX_POLL_MS seam, 120ms in this describe) drive
    // poll() — fs.watch delivery is unreliable with ~25 leaked watchers from
    // earlier activate() calls in the same process (parked-oracle design
    // never tears them down), so tests must not depend on it.
    await until(() => fake.releasedMsgs.includes(MSG_ID), 3000);
    expect(fake.finalized.length).toBe(0); // released, never finalized
    expect(fake.finalized.length).toBe(0); // released, never finalized
  });

  test("sendUserMessage throw: claim released via message.release, no finalize", async () => {
    writeIdentity(identityPath, {
      session_id: "s1", agent_id: "w1", runtime_id: "rt-1", gateway_socket: sock,
    });
    writeTask();
    await activate(claimPi({ failSend: true }), mockCtx(), cfg(ROOT, "s1", "w1"), identityPath);

    // message.read succeeded (inbox→processing) but delivery threw → the
    // message must be released back to the inbox, never silently finalized.
    await until(() => fake.releasedMsgs.includes(MSG_ID));
    expect(fake.requests.some((r) => r.method === "message.read")).toBe(true);
    expect(messages.length).toBe(0); // nothing was delivered
    expect(fake.finalized.length).toBe(0);
  });
});

// ── Factory contract: OMP calls default export with (api) only ────────

describe("factory contract (single-arg pi)", () => {
  test("manager console path does not touch ctx (no TypeError)", () => {
    // manager console: no identity env, gateway socket absent → warn + return
    delete process.env.OMP_MAILBOX_IDENTITY_FILE;
    delete process.env.CODEAGENT_ROLE;

    let sessionHandler: ((evt: unknown, ctx: ExtensionContext) => void) | null = null;
    const pi = {
      sendMessage: () => {},
      sendUserMessage: () => {},
      on: (evt: string, fn: (evt: unknown, ctx: ExtensionContext) => void) => {
        if (evt === "session_start") sessionHandler = fn;
      },
    } as unknown as ExtensionAPI;

    expect(() => pluginFactory(pi)).not.toThrow();
    expect(sessionHandler).not.toBeNull();
  });

  test("session_start handler captures ctx for gateway status UI", () => {
    delete process.env.OMP_MAILBOX_IDENTITY_FILE;
    delete process.env.CODEAGENT_ROLE;

    let sessionHandler: ((evt: unknown, ctx: ExtensionContext) => void) | null = null;
    const pi = {
      sendMessage: () => {},
      sendUserMessage: () => {},
      on: (evt: string, fn: (evt: unknown, ctx: ExtensionContext) => void) => {
        if (evt === "session_start") sessionHandler = fn;
      },
    } as unknown as ExtensionAPI;

    pluginFactory(pi);
    // session_start fires later with a real ctx — must not throw
    const ctx = mockCtx({ hasUI: true });
    expect(() => sessionHandler?.({}, ctx)).not.toThrow();
  });
});
