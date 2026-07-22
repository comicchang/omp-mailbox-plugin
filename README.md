# omp-mailbox-plugin

OMP extension for Syncthing-native direct-inbox worker-to-worker messaging.
No relay daemon, no Manager intervention — workers communicate directly through a shared filesystem.

**Detection**: `Bun.watch` (zero-latency inotify) + `ctx.setInterval` (60s fallback).

```
Worker A:  mailbox send → $MAILBOX_ROOT/{to}/inbox/{from}_{ts}.json
                              ↓ Syncthing sync + atomic rename
Worker B:  Bun.watch("rename") → poll → sendMessage(triggerTurn) → process
```

## Installation

    omp install git:github.com/comicchang/omp-mailbox-plugin

## Configuration

| Env | Required | Description |
|---|---|---|
| `OMP_WORKER_ID` | Yes | Worker ID matching inbox directory |
| `MAILBOX_ROOT` | No | Path to shared mailbox root |

## Usage

**Send:**
```
mailbox send --from ios-re --to ios-shader --subject "Glass done" --body "..."
```

**Receive** (automatic):
```
agent_end → check inbox → 1 pending → sendMessage(triggerTurn:true) → agent processes
```

**Idle detection** (dual mechanism):
```
Bun.watch(inboxDir)  → rename event → immediate poll  (primary, zero latency)
ctx.setInterval(60s) → periodic poll                  (fallback, Syncthing edge cases)
```

**Status update:**
```
mailbox status --worker ios-shader --state BUSY --current-task "glass shader"
```

**Clear archive + prune corrupt:**
```
mailbox clear --worker ios-shader --prune-corrupt --older-than-days 30
```

## Development

```
bun test
```

## Protocol

Messages are JSON files named `{from}_{YYYYMMDD}THHMMSSZ.json`:

```json
{"from":"ios-re","to":"ios-shader","subject":"...","body":"...",
 "kind":"REPORT","msg_id":"ios-re_20260722T153000Z","created_at":"..."}
```

Kinds: `TASK` (Manager→Worker), `REPORT` (Worker→Manager), `NOTICE` (diagnostic).

## License

MIT
