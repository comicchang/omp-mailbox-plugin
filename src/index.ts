import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

const POLL_MS = 30_000;
const CHECK_TIMEOUT_MS = 5_000;
const MAX_DEDUP_IDS = 100; // rolling dedup window

interface MailboxSummary {
  pending: number;
  messages: { from: string; kind: string; subject: string; msg_id: string }[];
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

async function runPeek(cfg: Config): Promise<MailboxSummary | null> {
  const proc = Bun.spawn([cfg.cliPath, "peek", "--worker", cfg.workerId], {
    stdout: "pipe", stderr: "pipe", timeout: CHECK_TIMEOUT_MS,
  });
  const out = await new Response(proc.stdout).text();
  if (!out.trim()) return null;
  try { return JSON.parse(out) as MailboxSummary; } catch { return null; }
}

export default function (pi: ExtensionAPI, ctx: ExtensionContext): void {
  const cfg = getConfig();
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
        if (seen.size > MAX_DEDUP_IDS) {
          // evict oldest — simple first-inserted-first-out
          seen.delete(seen.values().next().value!);
        }

        (pi as Record<string, unknown>).sendMessage?.(
          {
            customType: "omp-mailbox",
            content: `📬 MAILBOX: ${result.pending} pending\nFrom: ${msg.from}  Kind: ${msg.kind}\nSubject: ${msg.subject}`,
            display: true,
            attribution: { name: `mailbox:${msg.from}`, icon: "📬" },
          },
          { triggerTurn: true, deliverAs: "nextTurn" },
        );
      }
    } catch (e) { console.error("[mailbox] poll error:", e); } finally { polling = false; }
  }

  // Primary: inotify via Bun.watch (zero-latency)
  const ac = new AbortController();
  try {
    const watcher = Bun.watch(cfg.inboxDir, { signal: ac.signal, recursive: false });
    (async () => {
      for await (const event of watcher) {
        // handle both rename (atomic publish) and create (fallback for some filesystems)
        if (event === "rename" || event === "create") poll();
      }
    })().catch((e) => { console.error("[mailbox] watcher error:", e); });
  } catch (e) { console.error("[mailbox] watch setup failed:", e); }

  // Fallback: periodic poll (catches Syncthing edge cases + watch failures)
  ctx.setInterval(poll, POLL_MS);

  // Immediate check after each agent turn
  pi.on("agent_end", poll);

  // Cleanup on session end
  pi.on("session_shutdown", () => {
    ac.abort();
  });
}
