# Default Quick Voice Bridge (template)

This folder is the **default file-bridge** between Chief of Staff (Jarvis) and
Amazon Quick. Copy it to your bridge root, point the app at it, and Quick's
scheduled agent fills in the responses.

```bash
# 1. Copy this template to your bridge root (default location shown)
cp -R docs/bridge-template ~/Documents/CoS-Bridge

# 2. Tell the app where it lives (optional if you used the default path)
export COS_BRIDGE_ROOT=~/Documents/CoS-Bridge
```

## Layout

```
CoS-Bridge/
├── task_registry.json          # default bridge file: intent → task mapping
├── requests/                   # app writes request_*.json here
├── responses/
│   └── response.json           # Quick overwrites this on every task
└── outputs/
    ├── daily-summary.json      # per-task cached result (instant reads)
    ├── finance-summary.json
    ├── mom-update.json
    ├── email-check.json
    ├── calendar-check.json
    ├── booking-check.json
    └── system-status.json
```

## How it flows

1. You speak a command; the app matches it to a `task` via `task_registry.json`.
2. The app first reads `outputs/<task>.json` — if fresh (within
   `max_cache_age_minutes`), it speaks it instantly.
3. Otherwise it writes `requests/request_*.json` and waits.
4. Amazon Quick's `voice-bridge-watcher` agent (polls every ~5 min) runs the
   task, writes `responses/response.json` **and** `outputs/<task>.json`, then
   deletes the request file.

## Request / response schema

Request:

```json
{ "task": "<task-name>", "requested_at": "<ISO 8601>", "params": {} }
```

Response (both `response.json` and `outputs/<task>.json`):

```json
{
  "task": "<task-name>",
  "status": "completed" | "error",
  "completed_at": "<ISO 8601>",
  "summary": "<TTS-ready plain text — no markdown>",
  "data": { },
  "original_request": "<request filename>",
  "error": "<message, only when status=error>"
}
```

## Tasks in this build

`daily-summary`, `finance-summary` (CFO), `mom-update`, `email-check`,
`calendar-check`, `booking-check`, `system-status`.

> The **Chief Growth Officer** (`growth-summary`) task and **Marketing & Sales**
> are intentionally excluded from this build. To add a task, add it here and to
> `QUICK_TASKS` in `app.js`, then add a matching section to the Quick agent
> prompt (see `docs/quick-setup.md`).

The output files ship with placeholder summaries and a `1970` timestamp so they
read as "stale" until Quick generates real data on the first request.
