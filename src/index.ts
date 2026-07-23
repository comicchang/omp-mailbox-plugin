import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { readFileSync, existsSync, unlinkSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";

const POLL_MS = 30_000;
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

function getConfig(): Config | null {
  const sid = process.env.OMP_SESSION_ID;
  const wid = process.env.OMP_WORKER_ID;
  return sid && wid ? buildConfig(sid, wid) : null;
}

function identityPath(agentId = "default"): string {
  const dir = `${homedir()}/.omp/${agentId}`;
  try { mkdirSync(dir, { recursive: true }); } catch { /* ok */ }
  return `${dir}/mailbox-identity.json`;
}

function getConfigFromFile(): Config | null {
  const candidates = [process.env.OMP_WORKER_ID, "default"].filter(Boolean) as string[];
  for (const agent of candidates) {
    const path = identityPath(agent);
    try {
      if (!existsSync(path)) continue;
      const data = JSON.parse(readFileSync(path, "utf-8"));
      const sid = data.session_id || data.sessionId;
      const wid = data.worker_id || data.agentId || data.workerId;
      if (!sid || !wid) continue;
      console.error(`[mailbox] identity loaded: ${sid}/${wid} from ${path}`);
      return buildConfig(sid, wid);
    } catch { /* try next */ }
  }
  return null;
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

function activate(pi: ExtensionAPI, ctx: ExtensionContext, cfg: Config): void {
  let watcherAc: AbortController | null = null;
  let polling = false;
  const seen = new Set<string>();
  const intervalId: ReturnType<typeof setInterval> | null = null;

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

  // Fallback periodic poll (30s) — uses global setInterval if ctx.setInterval unavailable
  const timerFn = (ctx.setInterval ?? ((cb: () => void, ms: number) => setInterval(cb, ms))) as (cb: () => void, ms: number) => unknown;
  const interval = timerFn(() => { poll(); if (!watcherAc) watcherAc = setupWatcher(cfg.inboxDir, poll); }, POLL_MS);

  pi.on("agent_end", poll);
  pi.on("session_shutdown", () => {
    if (watcherAc) watcherAc.abort();
    clearInterval(interval as ReturnType<typeof setInterval>);
    try { unlinkSync(identityPath(cfg.agentId)); } catch { /* ok */ }
  });

  poll(); // immediate check for existing inbox messages
}

export default function (pi: ExtensionAPI, ctx: ExtensionContext): void {
  const cfg = getConfig();
  if (cfg) { activate(pi, ctx, cfg); return; }

  let activated = false;
  pi.on("agent_end", () => {
    if (activated) return;
    const cfg = getConfigFromFile() ?? getConfig();
    if (!cfg) return;
    activated = true;
    activate(pi, ctx, cfg);
  });
}
