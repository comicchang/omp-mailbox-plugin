import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { readFileSync, existsSync } from "node:fs";

const POLL_MS = 30_000;
const CHECK_TIMEOUT_MS = 5_000;
const MAX_DEDUP_IDS = 100;
const IDENTITY_FILE = `${process.env.HOME}/.omp/mailbox-identity.json`;

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

function getConfig(): Config | null {
  const sessionId = process.env.OMP_SESSION_ID;
  const agentId = process.env.OMP_WORKER_ID;
  if (!sessionId || !agentId) return null;
  const root = process.env.MAILBOX_ROOT ?? `${process.env.HOME}/Dropbox/logseq/pages/mi-docs/.mailbox`;
  const cli = process.env.MAILBOX_CLI ?? `${import.meta.dir}/../bin/mailbox`;
  return { sessionId, agentId, mailboxRoot: root, cliPath: cli, inboxDir: `${root}/${sessionId}/${agentId}/inbox` };
}

/** Agent writes this during INIT via shell: echo '{"session_id":"s","worker_id":"w"}' > ~/.omp/mailbox-identity.json */
function getConfigFromFile(): Config | null {
  try {
    if (!existsSync(IDENTITY_FILE)) return null;
    const data = JSON.parse(readFileSync(IDENTITY_FILE, "utf-8"));
    const sessionId = data.session_id || data.sessionId;
    const agentId = data.worker_id || data.agentId || data.workerId;
    if (!sessionId || !agentId) return null;
    const root = process.env.MAILBOX_ROOT ?? `${process.env.HOME}/Dropbox/logseq/pages/mi-docs/.mailbox`;
    const cli = process.env.MAILBOX_CLI ?? `${import.meta.dir}/../bin/mailbox`;
    console.error("[mailbox] identity loaded from file:", sessionId, agentId);
    return { sessionId, agentId, mailboxRoot: root, cliPath: cli, inboxDir: `${root}/${sessionId}/${agentId}/inbox` };
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

function activate(pi: ExtensionAPI, ctx: ExtensionContext, cfg: Config): void {
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
          {
            customType: "omp-mailbox",
            content: `📬 MAILBOX: ${result.pending} pending\nFrom: ${msg.from}  Kind: ${msg.kind}\nSubject: ${msg.subject}\n\n> notification — run mailbox read to consume`,
            display: true,
            attribution: { name: `mailbox:${msg.from}`, icon: "📬" },
          },
          { triggerTurn: true, deliverAs: "nextTurn" },
        );
      }
    } catch (e) { console.error("[mailbox] poll error:", e); } finally { polling = false; }
  }

  function setupWatcher(): AbortController | null {
    const ac = new AbortController();
    try {
      const watcher = Bun.watch(cfg.inboxDir, { signal: ac.signal, recursive: false });
      (async () => {
        for await (const event of watcher) {
          if (event === "rename" || event === "create") poll();
        }
      })().catch((e) => { console.error("[mailbox] watcher error:", e); });
      return ac;
    } catch (e) { console.error("[mailbox] watch setup failed:", e); return null; }
  }

  watcherAc = setupWatcher();

  ctx.setInterval(() => {
    poll();
    if (!watcherAc) watcherAc = setupWatcher();
  }, POLL_MS);

  pi.on("agent_end", poll);
  pi.on("session_shutdown", () => { if (watcherAc) watcherAc.abort(); });
}

export default function (pi: ExtensionAPI, ctx: ExtensionContext): void {
  const cfg = getConfig();
  if (cfg) { activate(pi, ctx, cfg); return; }

  let activated = false;
  pi.on("agent_end", () => {
    if (activated) return;
    const envCfg = getConfig();
    if (envCfg) { activated = true; activate(pi, ctx, envCfg); return; }
    const fileCfg = getConfigFromFile();
    if (fileCfg) { activated = true; activate(pi, ctx, fileCfg); return; }
  });
}
