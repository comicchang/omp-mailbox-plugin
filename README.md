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

## Installation

    omp install git:github.com/comicchang/omp-mailbox-plugin

## Configuration

| Env | Required | Description |
|---|---|---|
| `OMP_SESSION_ID` | Yes | Session identifier (same across session agents) |
| `OMP_WORKER_ID` | Yes | Agent ID matching inbox directory |
| `MAILBOX_ROOT` | No | Path to `_mailbox` root |
| `MAILBOX_CLI` | No | Path to `mailbox` CLI (default: `$MAILBOX_ROOT/tools/mailbox`)

## How it works

The plugin uses `mailbox peek` — a **non-consuming** summary command. The plugin
**never consumes messages**. The agent decides when to consume via `mailbox read`.

1. **Bun.watch** fires on `rename` or `create` events (zero-latency).
2. A **30-second interval** provides fallback coverage.
3. On **`agent_end`**, checks immediately after every completed turn.
4. Calls `mailbox peek --session <id> --agent <id>` — reads pending count + summaries.
5. Deduplicates via `msg_id` (bounded rolling Set, max 100).
6. Each **new** message triggers `sendMessage({ triggerTurn: true })`.

## Usage

**Send:**
```
mailbox send --session <s> --from ios-re --to ios-shader --subject "Glass done" --body "..." --kind EVIDENCE
```

**Receive** (plugin notifies, agent consumes):
```
plugin: agent_end → mailbox peek → 1 pending → sendMessage(triggerTurn)
agent:  receives notification → mailbox read --session <s> --agent ios-shader --owner ios-shader
        → process → mailbox finalize --session <s> --agent ios-shader --msg-id <id> --owner ios-shader
```

**Claim/consume pattern** (read auto-claims):
```
mailbox read    --session <s> --agent ios-shader --owner ios-shader   # reads + auto-claims
mailbox finalize --session <s> --agent ios-shader --msg-id <id> --owner ios-shader

## Protocol
Messages are atomic JSON files (`tmp → os.replace`), validated on consumption:

```json
{"session_id":"sess_20260723T01_abc","from":"ios-re","to":"ios-shader",
 "subject":"...","body":"...","kind":"REPORT",
 "msg_id":"ios-re_20260723T153000Z_abc123","created_at":"..."}
```

**8 required fields**: `session_id`, `from`, `to`, `subject`, `body`, `kind`, `msg_id`, `created_at`.
**Kinds**: TASK, REPORT, PROGRESS, EVIDENCE, QUESTION, RESPONSE, NOTICE.

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
