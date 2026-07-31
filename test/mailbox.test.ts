import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const MAILBOX_CLI = join(import.meta.dir, "..", "bin", "mailbox");
const ROOT = join(tmpdir(), `omp-mailbox-test-${Date.now()}`);
const SESSION = "sess1";
const AGENT = "worker-a";

function setup() {
  mkdirSync(join(ROOT, SESSION, AGENT, "inbox"), { recursive: true });
}

function teardown() {
  rmSync(ROOT, { recursive: true, force: true });
}

function run(args: string[], env: Record<string, string> = {}) {
  return Bun.spawnSync([MAILBOX_CLI, ...args], {
    env: { ...process.env, MAILBOX_ROOT: ROOT, ...env },
  });
}

function writeMsg(filename: string, msg: Record<string, unknown>) {
  writeFileSync(join(ROOT, SESSION, AGENT, "inbox", filename), JSON.stringify(msg));
}

describe("mailbox", () => {
  beforeAll(setup);
  afterAll(teardown);

  test("empty inbox returns empty summary", () => {
    const proc = run(["peek", "--session", SESSION, "--agent", AGENT]);
    expect(proc.exitCode).toBe(0);
    const out = JSON.parse(proc.stdout.toString());
    expect(out.pending).toBe(0);
    expect(out.messages).toHaveLength(0);
  });

  test("peek sees a message without consuming it", () => {
    writeMsg("mgr_20260722T120000Z.json", {
      session_id: SESSION, from: "mgr", to: AGENT,
      subject: "test", body: "hello", kind: "REPORT",
      msg_id: "mgr_20260722T120000Z", created_at: "2026-07-22T12:00:00Z",
    });

    const proc = run(["peek", "--session", SESSION, "--agent", AGENT]);
    expect(proc.exitCode).toBe(0);
    const out = JSON.parse(proc.stdout.toString());
    expect(out.pending).toBe(1);
    expect(out.messages[0].subject).toBe("test");
    // peek is non-consuming
    expect(existsSync(join(ROOT, SESSION, AGENT, "inbox", "mgr_20260722T120000Z.json"))).toBe(true);
  });

  test("read claims, finalize archives", () => {
    const read = run(["read", "--session", SESSION, "--agent", AGENT, "--owner", AGENT]);
    expect(read.exitCode).toBe(0);
    expect(read.stdout.toString()).toContain("FROM:");
    expect(read.stdout.toString()).toContain("mgr");

    const fin = run(["finalize", "--session", SESSION, "--agent", AGENT,
      "--msg-id", "mgr_20260722T120000Z", "--owner", AGENT]);
    expect(fin.exitCode).toBe(0);
    expect(existsSync(join(ROOT, SESSION, AGENT, "archive", "mgr_20260722T120000Z.json"))).toBe(true);
    expect(existsSync(join(ROOT, SESSION, AGENT, "inbox", "mgr_20260722T120000Z.json"))).toBe(false);
  });

  test("corrupt message is skipped by peek, archived by read", () => {
    writeFileSync(join(ROOT, SESSION, AGENT, "inbox", "bad.json"), "not json");

    // peek is read-only: tolerates the corrupt file without crashing
    const proc = run(["peek", "--session", SESSION, "--agent", AGENT]);
    expect(proc.exitCode).toBe(0);

    // read consumes it: corrupt file moves to _corrupt
    const rd = run(["read", "--session", SESSION, "--agent", AGENT, "--owner", AGENT]);
    expect(rd.exitCode).toBe(0);
    expect(existsSync(join(ROOT, SESSION, AGENT, "_corrupt", "bad.json"))).toBe(true);
    expect(existsSync(join(ROOT, SESSION, AGENT, "inbox", "bad.json"))).toBe(false);
  });

  test("status writes atomically", () => {
    const st = run(["status", "--session", SESSION, "--agent", AGENT,
      "--state", "BUSY", "--current-task", "test"]);
    expect(st.exitCode).toBe(0);

    const status = JSON.parse(readFileSync(join(ROOT, SESSION, AGENT, "status.json"), "utf-8"));
    expect(status.state).toBe("BUSY");
    expect(status.current_task).toBe("test");
  });
});
