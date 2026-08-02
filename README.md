# omp-mailbox-plugin

OMP extension for session-based direct-inbox worker-to-worker messaging.
No relay daemon — workers communicate through a shared Syncthing filesystem.

**Detection**: `Bun.watch` (zero-latency, rename+create) + `ctx.setInterval` (30s fallback) + `agent_end` immediate check.
**Activation**: deferred — waits for Worker agent to set `OMP_SESSION_ID` + `OMP_WORKER_ID` via INIT protocol.

```
Worker A:  mailbox send --session <id> --from A --to B → <session>/B/inbox/{msg_id}.json
                              ↓ Syncthing sync + atomic rename
Worker B:  Bun.watch("rename"|"create") → mailbox peek → sendMessage(triggerTurn) → read → finalize (auto-claim)
```

## Prerequisites

This plugin is a **thin notification adapter**. It delegates all mailbox operations to the
canonical `mailbox` CLI from [codeagent-py](https://github.com/anthropics/codeagent-py).

Install the CLI first:

```bash
pipx install codeagent-py        # installs 'mailbox' + 'codeagent' into PATH
```

On activation the plugin runs a capability check:
- Verifies `codeagent --version` returns 0 and version >= `MAILBOX_MIN_VERSION` (currently `0.1.0`);
- Falls back to verifying `mailbox --help` exits successfully.

If the check fails the plugin logs an error and throws — it does **not** silently degrade.

## Installation

    omp install git:github.com/comicchang/omp-mailbox-plugin

## Configuration

| Env | Required | Description |
|---|---|---|
| `OMP_SESSION_ID` | Yes | Session identifier (same across session agents) |
| `OMP_WORKER_ID` | Yes | Agent ID matching inbox directory |
| `MAILBOX_ROOT` | No | Path to mailbox root (default: `~/.local/share/codeagent/mailbox`) |
| `MAILBOX_CLI` | No | Path to `mailbox` CLI (default: `mailbox` from PATH) |

## How it works

The plugin uses `mailbox peek` — a **non-consuming** summary command. The plugin
**never consumes messages**. The agent decides when to consume via `mailbox read`.

1. **Bun.watch** fires on `rename` or `create` events (zero-latency).
2. A **30-second interval** provides fallback coverage.
3. On **`agent_end`**, checks immediately after every completed turn.
4. Calls `mailbox peek --session <id> --agent <id>` — reads pending count + summaries.
5. Deduplicates via `msg_id` (bounded rolling set, max 100).
6. Each **new** message triggers `sendMessage({ triggerTurn: true })`.

## Protocol

Messages are atomic JSON files (`tmp → os.replace`), validated on consumption:

```json
{"session_id":"sess_20260723T01_abc","from":"ios-re","to":"ios-shader",
 "subject":"...","body":"...","kind":"REPORT",
 "msg_id":"ios-re_20260723T153000Z_abc123","created_at":"..."}
```

**8 required fields**: `session_id`, `from`, `to`, `subject`, `body`, `kind`, `msg_id`, `created_at`.
**Kinds**: TASK, REPORT, PROGRESS, EVIDENCE, QUESTION, RESPONSE, NOTICE.

See `mailbox --help` for all available subcommands (send, peek, read, finalize, release, etc.).

## Development

Typecheck and test gate:

```bash
bun install
bun run typecheck    # tsc --noEmit — 0 errors required
bun test             # wake tests
```

CI script (from codeagent-py repo):

```bash
./scripts/check-plugin-types.sh         # defaults to ../omp-mailbox-plugin
./scripts/check-plugin-types.sh /path/to/plugin  # explicit path
```

## Directory Layout

```
$MAILBOX_ROOT/
  <session_id>/
    session.json          # {manager, agents, created_at}
    manager/inbox|processing|archive/
    <agent>/inbox|processing|archive/status.json
```

**Two-stage consumption**: `mailbox read` (reads + auto-claims to processing/) → agent processes → `mailbox finalize` (archives). `mailbox release` returns to inbox. `mailbox recover-stale` recovers expired claims (300s lease).

## License

MIT
