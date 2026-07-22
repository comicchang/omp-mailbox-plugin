# omp-mailbox-plugin

OMP extension for Syncthing-native direct-inbox worker-to-worker messaging.
No relay daemon, no Manager intervention — workers communicate directly through a shared filesystem.

```
Worker A:  mailbox send → $MAILBOX_ROOT/{to}/inbox/{from}_{ts}.json
                              ↓ Syncthing
Worker B:  OMP agent_end → poll inbox → inject context → process
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

**Receive** (automatic — no agent action):
```
agent_end → check inbox → 1 pending → sendMessage(triggerTurn:true) → agent processes
```

**Idle polling** (catches late-arriving messages):
```
ctx.setInterval → every 30s → check inbox → wake if pending
```

**Status update:**
```
mailbox status --worker ios-shader --state BUSY --current-task "glass shader"
```

## Directory Layout

```
$MAILBOX_ROOT/
  {worker_id}/
    inbox/        ← Others write here (Syncthing)
    archive/      ← Read messages (cleared at task end)
    _corrupt/     ← Unparseable messages
    status.json   ← Self-reported state
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
