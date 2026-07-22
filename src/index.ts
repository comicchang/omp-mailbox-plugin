import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

const POLL_MS = 30_000;
const CHECK_TIMEOUT_MS = 5_000;

interface MailboxSummary {
  pending: number;
  messages: { from: string; kind: string; subject: string }[];
}

interface Config {
  workerId: string;
  mailboxRoot: string;
  cliPath: string;
}

function getConfig(): Config {
  const workerId = process.env.OMP_WORKER_ID;
  if (!workerId) throw new Error("OMP_WORKER_ID is not set");
  return {
    workerId,
    mailboxRoot:
      process.env.OMP_MAILBOX_ROOT ??
      `${process.env.HOME}/Dropbox/logseq/pages/mi-docs/_mailbox`,
    cliPath:
      process.env.OMP_MAILBOX_CLI ??
      `${process.env.HOME}/Dropbox/logseq/pages/mi-docs/_mailbox/tools/mailbox`,
  };
}

async function runPending(cfg: Config): Promise<MailboxSummary | null> {
  const proc = Bun.spawn([cfg.cliPath, "check", "--worker", cfg.workerId, "--json"], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: CHECK_TIMEOUT_MS,
  });
  const out = await new Response(proc.stdout).text();
  if (!out.trim()) return null;
  try {
    return JSON.parse(out) as MailboxSummary;
  } catch {
    return null;
  }
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

      await pi.sendMessage(
        {
          customType: "omp-mailbox",
          content: `MAILBOX: ${result.pending} pending. From: ${msg.from}  Kind: ${msg.kind}\nSubject: ${msg.subject}`,
          display: true,
          attribution: { name: "mailbox", icon: "📬" },
          details: { pending: result.pending, from: msg.from, kind: msg.kind, subject: msg.subject },
        },
        { triggerTurn: true, deliverAs: "nextTurn" },
      );
    } catch {
      // best-effort; will retry on next poll
    } finally {
      polling = false;
    }
  }

  // Immediate check after each agent turn
  pi.on("agent_end", poll);

  // Idle polling via managed timer (auto-cleaned on session_shutdown)
  ctx.setInterval(poll, POLL_MS);
}
