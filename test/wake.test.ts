import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { activate, type Config } from "../src/index";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

// Check if canonical mailbox CLI is available on PATH
let MAILBOX_ON_PATH = true;
try {
  const proc = Bun.spawnSync(["mailbox", "--help"], { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) MAILBOX_ON_PATH = false;
} catch {
  MAILBOX_ON_PATH = false;
}

const describeOrSkip = MAILBOX_ON_PATH ? describe : describe.skip;

// Mock ExtensionAPI — named types, no inline imports / ReturnType.
interface SentMessage {
  msg: { content: string };
  opts: { triggerTurn: boolean };
}
interface MockApi {
  messages: SentMessage[];
  pi: {
    sendMessage: (msg: unknown, opts: unknown) => void;
    on: (evt: string, fn: () => void) => void;
  };
}

function mockApi(): MockApi {
  const messages: SentMessage[] = [];
  return {
    messages,
    pi: {
      sendMessage: (msg, opts) => {
        messages.push({ msg: msg as SentMessage["msg"], opts: opts as SentMessage["opts"] });
      },
      on: () => {},
    },
  };
}

function cfg(root: string, sid = "sess1", wid = "worker-a"): Config {
  return {
    sessionId: sid,
    agentId: wid,
    mailboxRoot: root,
    cliPath: process.env.MAILBOX_CLI ?? "mailbox",
    inboxDir: `${root}/${sid}/${wid}/inbox`,
  };
}

/** Wait for a predicate with a bounded poll (file-watch events, not timers). */
async function until(fn: () => boolean, ms = 3000, step = 100): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return;
    await Bun.sleep(step);
  }
  throw new Error(`condition not met within ${ms}ms`);
}

describeOrSkip("omp-mailbox-plugin wake-up", () => {
  const ROOT = join(tmpdir(), `omp-mailbox-wake-${Date.now()}`);
  const mailboxRoot = join(ROOT, "mailbox");
  const identityPath = join(ROOT, "identity.json");
  let api: MockApi;
  let inbox: string;

  beforeEach(() => {
    inbox = join(mailboxRoot, "sess1", "worker-a", "inbox");
    mkdirSync(inbox, { recursive: true });
    writeFileSync(identityPath, JSON.stringify({ session_id: "sess1", worker_id: "worker-a" }));
    api = mockApi();
  });

  afterEach(() => {
    rmSync(ROOT, { recursive: true, force: true });
  });

  test("new inbox message triggers sendMessage with triggerTurn (wakes idle agent)", async () => {
    await activate(api.pi as unknown as ExtensionAPI, {} as never, cfg(mailboxRoot), identityPath);

    const msg = {
      session_id: "sess1", from: "mgr", to: "worker-a",
      subject: "wake me", body: "hello", kind: "TASK",
      msg_id: "mgr_20260731T000000Z_wake1", created_at: "2026-07-31T00:00:00Z",
    };
    writeFileSync(join(inbox, "mgr_20260731T000000Z_wake1.json"), JSON.stringify(msg));

    await until(() => api.messages.length > 0);
    expect(api.messages[0].opts.triggerTurn).toBe(true);
    expect(api.messages[0].msg.content).toContain("wake me");
  });

  test("duplicate msg_id does not re-notify", async () => {
    await activate(api.pi as unknown as ExtensionAPI, {} as never, cfg(mailboxRoot), identityPath);

    const msg = {
      session_id: "sess1", from: "mgr", to: "worker-a",
      subject: "dup", body: "x", kind: "TASK",
      msg_id: "mgr_20260731T000000Z_dup", created_at: "2026-07-31T00:00:00Z",
    };
    const p = join(inbox, "mgr_20260731T000000Z_dup.json");
    writeFileSync(p, JSON.stringify(msg));
    await until(() => api.messages.length === 1);

    writeFileSync(p, JSON.stringify({ ...msg, body: "changed" }));
    await Bun.sleep(200); // allow a (suppressed) second event to attempt
    expect(api.messages.length).toBe(1);
  });
});
