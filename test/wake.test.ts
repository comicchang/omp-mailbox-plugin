import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  activate,
  startManagerReplyWatcher,
  MAX_NOTIFY_COUNT,
  MESSAGE_TTL_MS,
  RETRY_NOTIFY_MS,
  shouldNotify,
  type Config,
  type NotificationStats,
} from "../src/index";
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

describe("notification budget", () => {
  const stats = (overrides: Partial<NotificationStats> = {}): NotificationStats => ({
    firstAt: 0,
    lastAt: 0,
    count: 1,
    ...overrides,
  });

  test("allows the first notification", () => {
    expect(shouldNotify(undefined, 0)).toBe(true);
  });

  test("enforces the retry interval", () => {
    expect(shouldNotify(stats(), RETRY_NOTIFY_MS - 1)).toBe(false);
    expect(shouldNotify(stats(), RETRY_NOTIFY_MS)).toBe(true);
  });

  test("stops after the notification count cap", () => {
    expect(shouldNotify(stats({ count: MAX_NOTIFY_COUNT }), RETRY_NOTIFY_MS)).toBe(false);
  });

  test("stops when the message TTL expires", () => {
    expect(shouldNotify(stats(), MESSAGE_TTL_MS - 1)).toBe(true);
    expect(shouldNotify(stats(), MESSAGE_TTL_MS)).toBe(false);
  });

  test("allows notification at count MAX_NOTIFY_COUNT - 1 within retry window", () => {
    expect(shouldNotify(stats({ count: MAX_NOTIFY_COUNT - 1 }), RETRY_NOTIFY_MS)).toBe(true);
  });

  test("full lifecycle: three notifications then blocked", () => {
    // First notification (no stats)
    expect(shouldNotify(undefined, 0)).toBe(true);

    // After first notification, wait for retry
    const afterFirst: NotificationStats = { firstAt: 0, lastAt: 0, count: 1 };
    expect(shouldNotify(afterFirst, RETRY_NOTIFY_MS - 1)).toBe(false); // too early
    expect(shouldNotify(afterFirst, RETRY_NOTIFY_MS)).toBe(true); // retry window elapsed

    // After second notification
    const afterSecond: NotificationStats = { firstAt: 0, lastAt: RETRY_NOTIFY_MS, count: 2 };
    expect(shouldNotify(afterSecond, RETRY_NOTIFY_MS * 2 - 1)).toBe(false); // too early
    expect(shouldNotify(afterSecond, RETRY_NOTIFY_MS * 2)).toBe(true); // retry window elapsed

    // After third notification (count = MAX_NOTIFY_COUNT)
    const afterThird: NotificationStats = { firstAt: 0, lastAt: RETRY_NOTIFY_MS * 2, count: MAX_NOTIFY_COUNT };
    expect(shouldNotify(afterThird, RETRY_NOTIFY_MS * 3)).toBe(false); // count exhausted
  });

  test("TTL expires during retry cycle", () => {
    // Start near TTL boundary
    const nearTtl = MESSAGE_TTL_MS - RETRY_NOTIFY_MS;
    const stats1: NotificationStats = { firstAt: 0, lastAt: 0, count: 1 };

    // Retry allowed (within TTL)
    expect(shouldNotify(stats1, nearTtl)).toBe(true);

    // After retry, TTL expired
    const stats2: NotificationStats = { firstAt: 0, lastAt: nearTtl, count: 2 };
    expect(shouldNotify(stats2, MESSAGE_TTL_MS)).toBe(false); // TTL expired
  });
});

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

describeOrSkip("manager Oracle reply watcher", () => {
  const ROOT = join(tmpdir(), `omp-mailbox-manager-${Date.now()}`);
  const mailboxRoot = join(ROOT, "mailbox");
  const inbox = join(mailboxRoot, "sess1", "manager", "inbox");
  let stopWatcher: (() => void) | undefined;

  beforeEach(() => {
    mkdirSync(inbox, { recursive: true });
  });

  afterEach(() => {
    stopWatcher?.();
    stopWatcher = undefined;
    rmSync(ROOT, { recursive: true, force: true });
  });

  test("REPORT wakes OMP once with correlation metadata and persists dedup", async () => {
    const api = mockApi();
    const watcher = startManagerReplyWatcher(
      api.pi as unknown as ExtensionAPI,
      cfg(mailboxRoot, "sess1", "manager"),
    );
    stopWatcher = watcher.stop;
    const reportPath = join(inbox, "oracle-report-1.json");
    writeFileSync(reportPath, JSON.stringify({
      session_id: "sess1",
      from: "oracle",
      to: "manager",
      subject: "oracle result",
      body: JSON.stringify({ generation: 7, answer: "opaque" }),
      kind: "REPORT",
      msg_id: "oracle-report-1",
      reply_to: "ask-msg-1",
      run_id: "run-1",
      request_id: "req-1",
      created_at: "2026-09-10T00:00:00Z",
    }));

    await watcher.poll();
    expect(api.messages[0].opts.triggerTurn).toBe(true);
    expect(api.messages[0].msg.content).toContain("Request: req-1");
    expect(api.messages[0].msg.content).toContain("Generation: 7");
    expect(api.messages[0].msg.content).toContain("Message: oracle-report-1");
    expect(api.messages[0].msg.content).toContain("Reply to: ask-msg-1");
    expect(existsSync(reportPath)).toBe(true);

    watcher.stop();
    const restarted = mockApi();
    const restartedWatcher = startManagerReplyWatcher(
      restarted.pi as unknown as ExtensionAPI,
      cfg(mailboxRoot, "sess1", "manager"),
    );
    stopWatcher = restartedWatcher.stop;
    await restartedWatcher.poll();
    expect(restarted.messages).toHaveLength(0);
  });

  test("non-REPORT messages do not wake the manager", async () => {
    const api = mockApi();
    const watcher = startManagerReplyWatcher(
      api.pi as unknown as ExtensionAPI,
      cfg(mailboxRoot, "sess1", "manager"),
    );
    stopWatcher = watcher.stop;
    writeFileSync(join(inbox, "task-1.json"), JSON.stringify({
      session_id: "sess1",
      from: "worker",
      to: "manager",
      subject: "new task",
      body: "not a reply",
      kind: "TASK",
      msg_id: "task-1",
      request_id: "req-task",
      run_id: "run-task",
      created_at: "2026-09-10T00:00:00Z",
    }));

    await watcher.poll();
    expect(api.messages).toHaveLength(0);
    expect(existsSync(join(inbox, "task-1.json"))).toBe(true);
  });
});
