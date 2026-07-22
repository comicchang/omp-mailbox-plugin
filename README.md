# omp-mailbox-plugin

OMP extension for Syncthing-native direct-inbox worker-to-worker messaging. No relay daemon, no Manager intervention — workers communicate directly through a shared filesystem.

## How It Works

```
Worker A:  mailbox send → $MAILBOX_ROOT/{to}/inbox/{from}_{ts}.json
                              ↓ Syncthing syncs
Worker B:  OMP agent_end / periodic poll → auto-inject → agent context
```

## Features

- **Zero relay** — Syncthing handles cross-machine delivery
- **Auto-notification** — `agent_end` hook + 30s idle polling via `ctx.setInterval`
- **Wake on message** — `triggerTurn: true` starts a new OMP turn when mail arrives
- **Type-safe** — Full `ExtensionAPI` types, no `any`
- **Standalone CLI** — `tools/mailbox` works without OMP for scripting/testing

## Installation

```bash
omp install git:github.com/comicchang/omp-mailbox-plugin
```

Or via dotai `components.json` (auto-installed during setup).

## Configuration

| Env | Required | Default | Description |
|---|---|---|---|
| `OMP_WORKER_ID` | Yes | — | This worker's ID (must match inbox directory) |
| `MAILBOX_ROOT` | No | `$HOME/Dropbox/logseq/pages/mi-docs/_mailbox` | Path to shared mailbox root |

## Mailbox Protocol

Messages are JSON files named `{from}_{YYYYMMDD}THHMMSSZ.json`.

```json
{
  "from": "ios-re",
  "to": "ios-shader",
  "subject": "Glass shader analysis complete",
  "body": "Passes mapped: vibrant_light, sdf_key_fill, ...",
  "kind": "REPORT",
  "msg_id": "ios-re_20260722T153000Z",
  "created_at": "2026-07-22T15:30:00Z"
}
```

### Kinds

| Kind | Use |
|---|---|
| `TASK` | Manager → Worker task dispatch |
| `REPORT` | Worker → Manager/Worker results |
| `NOTICE` | Diagnostic / status updates |

### Directory Layout

```
$MAILBOX_ROOT/
  {worker_id}/
    inbox/          ← Others write here (Syncthing)
    archive/        ← Read messages (cleared at task end)
    _corrupt/       ← Unparseable messages
    processing/     ← In-flight claim lock
    status.json     ← Worker self-reported state
```

### status.json

```json
{
  "state": "BUSY",
  "current_task": "Glass shader rebuild",
  "last_conclusion": "4 sub-functions mapped, 3 implemented",
  "updated_at": "2026-07-22T15:22:49Z"
}
```

## Development

```bash
bun install
bun test
```

## License

MIT
