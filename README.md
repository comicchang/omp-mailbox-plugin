# omp-mailbox-plugin

OMP extension for Syncthing-native direct-inbox worker-to-worker messaging.
No relay daemon, no Manager intervention — workers communicate directly through a shared filesystem.

**Detection**: `Bun.watch` (zero-latency inotify, rename+create) + `ctx.setInterval` (30s fallback).

```
Worker A:  mailbox send → $MAILBOX_ROOT/{to}/inbox/{msg_id}.json
                              ↓ Syncthing sync + atomic rename
Worker B:  Bun.watch("rename"|"create") → mailbox peek → sendMessage(triggerTurn) → process
```

## Installation

    omp install git:github.com/comicchang/omp-mailbox-plugin

## Configuration

| Env | Required | Description |
|---|---|---|
| `OMP_WORKER_ID` | Yes | Worker ID matching inbox directory |
| `MAILBOX_ROOT` | No | Path to shared mailbox root |
| `MAILBOX_CLI` | No | Path to `mailbox` CLI (default: `$MAILBOX_ROOT/tools/mailbox`) |

## How it works

The plugin uses `mailbox peek` — a **non-consuming** summary command that lists pending messages without archiving them. Actual consumption is done by the Worker agent at safe boundaries via `mailbox check` or `mailbox claim → process → check`.

1. **Bun.watch** fires on `rename` or `create` events in the inbox directory (zero-latency).
2. A **30-second interval** provides fallback coverage for Syncthing edge cases and watch failures.
3. On **`agent_end`**, the plugin checks immediately after every completed agent turn.
4. It calls `mailbox peek --worker <id>` to get a `{pending, messages[]}` summary.
5. Duplicates are filtered via `msg_id` (bounded rolling Set, max 100).
6. Each **new** message triggers `sendMessage({ triggerTurn: true })` with sender/kind/subject.

Errors are logged to stderr via `console.error` with `[mailbox]` prefix — no silent failures.

## Usage

**Send:**
```
mailbox send --from ios-re --to ios-shader --subject "Glass done" --body "..." --kind EVIDENCE
```

**Receive** (automatic via plugin):
```
agent_end → mailbox peek → N pending → sendMessage(triggerTurn:true) → agent processes
```

**Idle detection** (dual mechanism):
```
Bun.watch(inboxDir)   → rename/create → immediate poll  (primary, zero latency)
ctx.setInterval(30s)  → periodic poll                    (fallback, Syncthing edge cases)
```

**Status update:**
```
mailbox status --worker ios-shader --state BUSY --current-task "glass shader"
```

**Claim/consume pattern** (for crash-safe processing):
```
mailbox claim   --worker ios-shader --msg-id ios-re_20260722T153000Z
# ... process ...
mailbox check   --worker ios-shader --json     # validate + archive
```

## Protocol

Messages are atomic JSON files (`tmp → os.replace`), validated on consumption:

```json
{"from":"ios-re","to":"ios-shader","subject":"...","body":"...",
 "kind":"REPORT","msg_id":"ios-re_20260722T153000Z","created_at":"..."}
```

**7 required fields**: `from`, `to`, `subject`, `body`, `kind`, `msg_id`, `created_at`.

**Kinds**: TASK, REPORT, PROGRESS, EVIDENCE, QUESTION, RESPONSE, NOTICE.

Validation on `mailbox check`: all fields present, kind valid, `msg_id` matches filename, recipient matches inbox owner, no path separators in `msg_id`. Corrupt → `_corrupt/`.

## Directory Layout

```
$MAILBOX_ROOT/
  {worker_id}/
    inbox/        ← Others write (Syncthing)
    archive/      ← Validated + consumed
    processing/   ← Claimed (exclusive, claim/release)
    _corrupt/     ← Unparseable
    status.json   ← {"state":"BUSY","current_task":"...","last_conclusion":"..."}
```

## License

MIT
