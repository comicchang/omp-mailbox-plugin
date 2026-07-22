import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

const POLL_MS = 60_000;
const CHECK_TIMEOUT_MS = 5_000;

interface MailboxSummary {
  pending: number;
  messages: { from: string; kind: string; subject: string }[];
}

interface Config {
  workerId: string;
  mailboxRoot: string;
  cliPath: string;
  inboxDir: string;
}

function getConfig(): Config {
  const workerId = process.env.OMP_WORKER_ID;
  if (!workerId) throw new Error("OMP_WORKER_ID is not set");
  const root = process.env.MAILBOX_ROOT ?? `${process.env.HOME}/Dropbox/logseq/pages/mi-docs/_mailbox`;
  const cli = process.env.MAILBOX_CLI ?? `${root}/tools/mailbox`;
  return { workerId, mailboxRoot: root, cliPath: cli, inboxDir: `${root}/${workerId}/inbox` };
}

async function runPending(cfg: Config): Promise<MailboxSummary | null> {
  const proc = Bun.spawn([cfg.cliPath, "check", "--worker", cfg.workerId, "--json"], {
    stdout: "pipe", stderr: "pipe", timeout: CHECK_TIMEOUT_MS,
  });
  const out = await new Response(proc.stdout).text();
  if (!out.trim()) return null;
  try { return JSON.parse(out) as MailboxSummary; } catch { return null; }
}

export default function (pi: ExtensionAPI, ctx: ExtensionContext): void {
  const cfg = getConfig();
  let polling = false;
  let lastMsgId: string | null = null;

  async function poll(): Promise<void> {
    if (polling) return;
    polling = true;
    try {
      const result = await runPending(cfg);
      if (!result || result.messages.length === 0) return;
      const msg = result.messages[0];
      if (msg.from + msg.subject === lastMsgId) return;
      lastMsgId = msg.from + msg.subject;

      (pi as Record<string, unknown>).sendMessage?.(
        {
          customType: "omp-mailbox",
          content: `MAILBOX: ${result.pending} pending. From: ${msg.from}  Kind: ${msg.kind}\nSubject: ${msg.subject}`,
          display: true,
          attribution: { name: "mailbox", icon: "📬" },
        },
        { triggerTurn: true, deliverAs: "nextTurn" },
      );
    } catch { /* retry next cycle */ } finally { polling = false; }
  }

  // Primary: inotify via Bun.watch (zero-latency)
  const ac = new AbortController();
  try {
    const watcher = Bun.watch(cfg.inboxDir, { signal: ac.signal, recursive: false });
    (async () => {
      for await (const event of watcher) {
        if (event === "rename") poll();  // atomic tmp→final triggers rename
      }
    })().catch(() => {});
  } catch { /* watch unavailable — fall through to timer only */ }

  // Fallback: periodic poll (catches Syncthing edge cases + watch failures)
  ctx.setInterval(poll, POLL_MS);

  // Immediate check after each agent turn
  pi.on("agent_end", poll);

  // Cleanup on session end
  pi.on("session_shutdown", () => {
    ac.abort();
  });
}
