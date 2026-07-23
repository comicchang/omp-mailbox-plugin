import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { readFileSync, existsSync, unlinkSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

const POLL_MS = 30_000;
const IDENTITY_POLL_MS = 2_000;
const CHECK_TIMEOUT_MS = 5_000;
const MAX_DEDUP_IDS = 100;

interface MailboxSummary {
  pending: number;
  messages: { from: string; kind: string; subject: string; msg_id: string }[];
}

interface Config {
  sessionId: string;
  agentId: string;
  mailboxRoot: string;
  cliPath: string;
  inboxDir: string;
}

function buildConfig(sessionId: string, agentId: string): Config {
  const root = process.env.MAILBOX_ROOT ?? `${homedir()}/Dropbox/logseq/pages/mi-docs/.mailbox`;
  const cli = process.env.MAILBOX_CLI ?? `${import.meta.dir}/../bin/mailbox`;
  return { sessionId, agentId, mailboxRoot: root, cliPath: cli, inboxDir: `${root}/${sessionId}/${agentId}/inbox` };
}

function generateIdentityPath(): string {
  const dir = `${homedir()}/.omp/mailbox-identity`;
  mkdirSync(dir, { recursive: true });
  const nonce = randomBytes(4).toString("hex");
  return `${dir}/${process.pid}-${nonce}.json`;
}

function readIdentityFile(path: string): Config | null {
  try {
    if (!existsSync(path)) return null;
    const data = JSON.parse(readFileSync(path, "utf-8"));
    const sid = data.session_id || data.sessionId;
    const wid = data.worker_id || data.agentId || data.workerId;
    if (!sid || !wid) return null;
    console.error(`[mailbox] identity loaded: ${sid}/${wid} from ${path}`);
    return buildConfig(sid, wid);
  } catch { return null; }
}

async function runPeek(cfg: Config): Promise<MailboxSummary | null> {
  const proc = Bun.spawn([cfg.cliPath, "peek", "--session", cfg.sessionId, "--agent", cfg.agentId], {
    stdout: "pipe", stderr: "pipe", timeout: CHECK_TIMEOUT_MS,
  });
  const out = await new Response(proc.stdout).text();
  if (!out.trim()) return null;
  try { return JSON.parse(out) as MailboxSummary; } catch { return null; }
}

function setupWatcher(inboxDir: string, poll: () => void): AbortController | null {
  const ac = new AbortController();
  try {
    const watcher = Bun.watch(inboxDir, { signal: ac.signal, recursive: false });
    (async () => {
      for await (const event of watcher) {
        if (event === "rename" || event === "create") poll();
      }
    })().catch((e) => { console.error("[mailbox] watcher error:", e); });
    return ac;
  } catch { console.error("[mailbox] watch setup failed:", inboxDir); return null; }
}

function activate(pi: ExtensionAPI, ctx: ExtensionContext, cfg: Config, identityPath: string): void {
  let watcherAc: AbortController | null = null;
  let polling = false;
  const seen = new Set<string>();

  async function poll(): Promise<void> {
    if (polling) return;
    polling = true;
    try {
      const result = await runPeek(cfg);
      if (!result || result.messages.length === 0) return;
      for (const msg of result.messages) {
        if (seen.has(msg.msg_id)) continue;
        seen.add(msg.msg_id);
        if (seen.size > MAX_DEDUP_IDS) seen.delete(seen.values().next().value!);
        (pi as Record<string, unknown>).sendMessage?.(
          { customType: "omp-mailbox", display: true,
            content: `📬 MAILBOX: ${result.pending} pending\nFrom: ${msg.from}  Kind: ${msg.kind}\nSubject: ${msg.subject}\n\n> notification — run mailbox read to consume`,
            attribution: { name: `mailbox:${msg.from}`, icon: "📬" } },
          { triggerTurn: true, deliverAs: "nextTurn" },
        );
      }
    } catch (e) { console.error("[mailbox] poll error:", e); } finally { polling = false; }
  }

  watcherAc = setupWatcher(cfg.inboxDir, poll);
  const interval = setInterval(() => { poll(); if (!watcherAc) watcherAc = setupWatcher(cfg.inboxDir, poll); }, POLL_MS);
  pi.on("agent_end", poll);
  pi.on("session_shutdown", () => {
    if (watcherAc) watcherAc.abort();
    clearInterval(interval);
    try { unlinkSync(identityPath); } catch { /* ok */ }
  });

  poll();
}

export default function (pi: ExtensionAPI, ctx: ExtensionContext): void {
  // Fast path: env vars pre-set (launcher scenario)
  const sid = process.env.OMP_SESSION_ID;
  const wid = process.env.OMP_WORKER_ID;
  if (sid && wid) { activate(pi, ctx, buildConfig(sid, wid), generateIdentityPath()); return; }

  // Per-process identity file: each OMP instance gets a unique path
  const identityPath = generateIdentityPath();
  process.env.OMP_MAILBOX_IDENTITY_FILE = identityPath;
  console.error(`[mailbox] identity file: ${identityPath}`);

  // Poll for identity file every2s; activate when found
  const idInterval = setInterval(() => {
    const cfg = readIdentityFile(identityPath);
    if (!cfg) return;
    clearInterval(idInterval);
    activate(pi, ctx, cfg, identityPath);
  }, IDENTITY_POLL_MS);

  pi.on("session_shutdown", () => {
    clearInterval(idInterval);
    try { unlinkSync(identityPath); } catch { /* ok */ }
  });
}
