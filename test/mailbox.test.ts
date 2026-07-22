import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const MAILBOX_CLI = join(import.meta.dir, "..", "..", "tmux-agent-skills", "tools", "mailbox");
const ROOT = join(tmpdir(), `omp-mailbox-test-${Date.now()}`);
const WORKER = "test-worker";

function setup() {
  for (const d of [join(ROOT, WORKER, "inbox"), join(ROOT, WORKER, "archive"), join(ROOT, WORKER, "_corrupt")]) {
    mkdirSync(d, { recursive: true });
  }
}

function teardown() {
  rmSync(ROOT, { recursive: true, force: true });
}

function writeMsg(filename: string, msg: Record<string, unknown>) {
  writeFileSync(join(ROOT, WORKER, "inbox", filename), JSON.stringify(msg));
}

function spawnCheck(json: boolean) {
  const args = json ? [MAILBOX_CLI, "check", "--worker", WORKER, "--json"] : [MAILBOX_CLI, "check", "--worker", WORKER];
  return Bun.spawnSync(args, { env: { ...process.env, MAILBOX_ROOT: ROOT } });
}

describe("mailbox", () => {
  beforeAll(setup);
  afterAll(teardown);

  test("empty inbox returns nothing", () => {
    const proc = spawnCheck(true);
    expect(proc.stdout.toString()).toBe("");
    expect(proc.exitCode).toBe(0);
  });

  test("message is read, validated, and archived", () => {
    writeMsg("sender_20260722T120000Z.json", {
      from: "sender", to: WORKER, subject: "test", body: "hello",
      kind: "REPORT", msg_id: "sender_20260722T120000Z",
      created_at: "2026-07-22T12:00:00Z",
    });

    const proc = spawnCheck(false);
    const out = proc.stdout.toString();
    expect(out).toContain("FROM:");
    expect(out).toContain("sender");
    expect(proc.exitCode).toBe(0);

    expect(existsSync(join(ROOT, WORKER, "archive", "sender_20260722T120000Z.json"))).toBe(true);
    expect(existsSync(join(ROOT, WORKER, "inbox", "sender_20260722T120000Z.json"))).toBe(false);
  });

  test("corrupt message goes to _corrupt", () => {
    writeFileSync(join(ROOT, WORKER, "inbox", "bad.json"), "not json");

    const proc = spawnCheck(true);
    expect(proc.stdout.toString()).toBe("");
    expect(existsSync(join(ROOT, WORKER, "_corrupt", "bad.json"))).toBe(true);
  });

  test("status writes atomically", () => {
    Bun.spawnSync([MAILBOX_CLI, "status", "--worker", WORKER, "--state", "BUSY",
      "--current-task", "test", "--last-conclusion", "testing"], {
      env: { ...process.env, MAILBOX_ROOT: ROOT },
    });

    const status = JSON.parse(readFileSync(join(ROOT, WORKER, "status.json"), "utf-8"));
    expect(status.state).toBe("BUSY");
    expect(status.current_task).toBe("test");
    expect(status.last_conclusion).toBe("testing");
  });
});
