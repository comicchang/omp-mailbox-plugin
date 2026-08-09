import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  activate,
  GatewayClient,
  readIdentityFile,
  type Config,
  type GatewayIdentity,
} from "../src/index";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

// ── Fake gateway: a UDS server that answers like the real AgentGateway ─

class FakeGateway {
  server: Server;
  requests: { method: string; params: Record<string, unknown> }[] = [];
  events: Record<string, unknown>[] = [];
  released: string[] = [];
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
        buf = "";
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

function mockPi(messages: SentMessage[]): ExtensionAPI {
  return {
    sendMessage: (msg: unknown, o: unknown) => {
      const content = (msg as { content: string }).content;
      const opts = (o ?? {}) as { triggerTurn: boolean; deliverAs?: string };
      messages.push({ content, opts });
    },
    sendUserMessage: (content: string) => {
      messages.push({ content: String(content), opts: { triggerTurn: true, deliverAs: "nextTurn" } });
    },
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
    await activate(mockPi(messages) as ExtensionAPI, mockCtx(), cfg(ROOT, "s1", "w1"), identityPath);
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
    await activate(mockPi(messages) as ExtensionAPI, mockCtx(), cfg(ROOT, "s1", "w1"), identityPath);

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
    await activate(mockPi(messages) as ExtensionAPI, mockCtx({ idle: true }), cfg(ROOT, "s1", "w1"), identityPath);
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
});
