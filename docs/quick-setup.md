# Amazon Quick — Bridge Setup

Chief of Staff (Jarvis) is a **local, offline HUD**. It never calls a
third-party API directly. Instead, it exchanges JSON files with **Amazon Quick**
through the file-bridge (see `voice-bridge-spec.md` and `bridge-template/`).
Amazon Quick is where the real integrations live: it connects to your email,
calendar, MCP servers, and Kiro Powers, then writes answers back to the bridge.

This guide sets up the four bridge paths shipped in this build:

| Bridge path | Task | What Quick connects to |
|-------------|------|------------------------|
| Chief Financial Officer (CFO) | `finance-summary` | Your **financial report emails** |
| UX Design Shop | *(local, via Kiro)* | **Open Design MCP** |
| Chief Security Officer (CSO) | *(local, via Kiro)* | **Kiro Power: AWS Security Agent** |
| Daily Report | `daily-summary` | Your **daily work email** |

> **Excluded in this build:** the Chief Growth Officer (`growth-summary`) and
> Marketing & Sales roles are intentionally left out of the UI and the bridge.

---

## 0. Prerequisite: install Quick + create the bridge

If you call a Quick capability (e.g. the CFO) before this is done, the app will
tell you Quick isn't set up and point you here — it won't just hang.

### Step 1 — Install Amazon Quick

Install **Amazon Quick** (Amazon Quick Suite): <https://quick.amazon.com>.
Quick is what connects to your email/calendar and produces the briefings.

### Step 2 — Pick the bridge folder

The app reads/writes the bridge at `COS_BRIDGE_ROOT` (default
`~/Documents/CoS-Bridge`). You only need to make sure the `requests/` folder
exists — **Quick creates `responses/` and `outputs/` itself** the first time it
runs a task (the app never creates those; it only reads them):

```bash
mkdir -p ~/Documents/CoS-Bridge/requests
export COS_BRIDGE_ROOT=~/Documents/CoS-Bridge
# Optional: copy the reference task registry so you have the task list handy
cp docs/bridge-template/task_registry.json ~/Documents/CoS-Bridge/ 2>/dev/null || true
```

### Step 3 — Give Amazon Quick the watcher instructions

In **Amazon Quick**, create a **scheduled agent named `voice-bridge-watcher`**
that runs every 5 minutes, and paste it the instructions below. This is the
piece that makes the bridge work — **Quick owns creating the folders and files**.

> **Copy-paste this into the Quick `voice-bridge-watcher` agent prompt:**
>
> ````text
> You are the voice-bridge-watcher for the Chief of Staff (Jarvis) app.
> Every 5 minutes, do the following against the bridge folder
> BRIDGE_ROOT = ~/Documents/CoS-Bridge  (expand ~ to my home folder):
>
> 1. Ensure these folders exist; CREATE them if missing:
>       BRIDGE_ROOT/requests/
>       BRIDGE_ROOT/responses/
>       BRIDGE_ROOT/outputs/
> 2. Read every *.json file in BRIDGE_ROOT/requests/. Each has the shape
>       { "task": "<task-name>", "requested_at": "<ISO8601>", "params": {} }
> 3. For each request, run the matching task (see TASKS below) and WRITE the
>    result to BOTH of these files (create/overwrite them):
>       BRIDGE_ROOT/responses/response.json         (the shared latest result)
>       BRIDGE_ROOT/outputs/<task>.json             (per-task cache)
>    using EXACTLY this JSON shape:
>       {
>         "task": "<task-name>",
>         "status": "completed" | "error",
>         "completed_at": "<ISO8601 now>",
>         "summary": "<plain, TTS-ready text — no markdown, no bullet chars>",
>         "data": { ... task-specific metrics ... },
>         "original_request": "<the request filename>",
>         "error": "<message, only when status=error>"
>       }
> 4. DELETE each request file after you process it (even on error).
>
> TASKS:
>   • finance-summary  (the CFO): read my most recent financial-report emails
>     (e.g. an "AWS Cost Report" or my accounting summary). Summarize yesterday's
>     spend, month-to-date, week-over-week and month-over-month trends, top cost
>     drivers, and any LLM/model spend, in a CFO-style spoken briefing.
>   • daily-summary: last 24h of work email + today's calendar, as a morning
>     briefing.
>   • calendar-check, email-check, booking-check, mom-update, system-status:
>     see the descriptions in task_registry.json.
>
> Always write valid JSON. The "summary" field is read aloud, so keep it
> conversational and free of markdown.
> ````

Confirm setup by asking Jarvis for the CFO ("call the CFO"). The first run
takes a few minutes; after that it's instant from the cache. Keep the agent's
task list in sync with `bridge-template/task_registry.json`.

---

## 1. Chief Financial Officer (CFO) — `finance-summary`

**Goal:** a spoken CFO briefing built from the **customer's financial report
emails** (for example a daily "AWS Cost Report" or an accounting summary the
customer receives by email).

**In Amazon Quick:**

1. Connect the **Gmail / email** integration for the mailbox that receives the
   financial reports.
2. In the `voice-bridge-watcher` agent prompt, add a `finance-summary` section:

   > When `task` = `finance-summary`: find the most recent financial report
   > email (e.g. subject contains "Cost Report" or the customer's report name)
   > from the connected mailbox. Extract yesterday's spend, month-to-date,
   > week-over-week and month-over-month trends, the top service/cost drivers,
   > and any LLM/model spend. Write a CFO-style, spoken-friendly `summary`
   > (no markdown) and populate `data` per the `finance-summary` schema in
   > `bridge-template/outputs/finance-summary.json`.

3. Point the report source at the **customer's own financial report emails** —
   swap the example sender/subject for whatever the customer actually receives.

**Test it:** say "call the CFO" (or "finance summary"). The app requests
`finance-summary`; within ~5 minutes Quick fills in
`outputs/finance-summary.json` and Jarvis speaks it. After the first run of the
day it reads instantly from cache.

---

## 2. UX Design Shop — Open Design MCP (bundled)

**Goal:** "call my design shop" spins up a new design project. This path is
served **locally through the bundled Open Design MCP**, not through the Quick
file-bridge.

**Open Design ships with this app** as a git submodule at
`third_party/open-design` — customers do not need a separate Open Design
checkout. Fresh clones must pull the submodule and build it once.

### Step 1 — get + build the bundled Open Design (one time)

```bash
# If you didn't clone with --recurse-submodules:
git submodule update --init --recursive

# Install Node 24 + pnpm if needed, then build the od CLI + daemon:
./scripts/setup-open-design.sh
```

`setup-open-design.sh` verifies Node 24 and pnpm, runs `pnpm install` and
`pnpm bootstrap` inside the submodule, and leaves a runnable `od` CLI at
`third_party/open-design/node_modules/.bin/od`.

### Step 2 — register the MCP server in Kiro

Copy the `open-design` entry from [`open-design.mcp.json`](../open-design.mcp.json)
(in the repo root) into your Kiro MCP config — workspace
`.kiro/settings/mcp.json` or user `~/.kiro/settings/mcp.json`:

```json
{
  "mcpServers": {
    "open-design": {
      "type": "stdio",
      "command": "node",
      "args": [
        "third_party/open-design/apps/daemon/bin/od.mjs",
        "mcp",
        "--daemon-url",
        "http://127.0.0.1:7456"
      ]
    }
  }
}
```

> The MCP server is a stdio **proxy** to the local Open Design daemon; it holds
> no state. If you run the daemon on a different port, match `--daemon-url`.

### Step 3 — the app launches the daemon on demand

You do **not** need to start the daemon manually. When you say "call my design
shop," the app spawns the bundled `od` daemon for you (see `launchDesignShop` in
`app.js` and the `open-design` IPC handler in `electron-main.js`), then opens the
design web UI in your browser. The app auto-resolves the bundled `od` binary
from `third_party/open-design`; set `OD_BIN` only to point at a different
install.

To start it manually anyway (e.g. for debugging):

```bash
cd third_party/open-design
pnpm tools-dev        # starts the local daemon
```

**Wire the app to the `od` CLI** so the "design shop" voice command can launch
it directly (see `launchDesignShop` in `app.js`):

```bash
export OD_BIN=/Users/coumit/workspace/open-design/node_modules/.bin/od
# optional, if you run the daemon on a non-default port:
export OD_DAEMON_URL=http://127.0.0.1:57776
```

**Test it:** say "call my design shop, start a new design of a landing page."
Kiro (via the Open Design MCP / `od` CLI) creates a project and opens it in your
browser. No Quick bridge task is involved.

---

## 3. Chief Security Officer (CSO) — Kiro Power: AWS Security Agent

**Goal:** "call my CSO" / "run a security review" runs an AWS security posture
review. This path runs **locally through Kiro** using the **AWS Security Agent
Kiro Power** — the Kiro solution repo already routes the voice command to a
`chief-security-officer` agent (see `runSecurity` in `app.js`), so you only need
to turn the Power on.

**Turn on the AWS Security Agent Power in Kiro:**

1. Open Kiro's **Powers** panel and locate **AWS Security Agent** (it ships
   installed).
2. Enable it. This activates its MCP server (`security-agent`, i.e.
   `awslabs.security-agent-mcp-server`). In `~/.kiro/settings/mcp.json` it
   appears under `powers.mcpServers` as
   `power-aws-security-agent-security-agent` — set `"disabled": false`:

   ```json
   "power-aws-security-agent-security-agent": {
     "command": "uvx",
     "args": ["awslabs.security-agent-mcp-server@latest"],
     "disabled": false
   }
   ```

3. Ensure `uv`/`uvx` is installed (see the README prerequisites) and that your
   AWS credentials are available (read-only is preferred for reviews).

**Test it:** say "call my CSO" or "run a security review." Kiro runs the AWS
Security Agent Power and Jarvis speaks the prioritized findings. No Quick bridge
task is involved.

---

## 4. Daily Report — daily work email integration — `daily-summary`

**Goal:** a spoken morning briefing built from your **daily work email**.

**In Amazon Quick:**

1. Connect the **email** integration for your work mailbox (and Calendar, if you
   want events included).
2. Add a `daily-summary` section to the `voice-bridge-watcher` prompt:

   > When `task` = `daily-summary`: pull the last 24 hours of work email and
   > any relevant daily digest/report emails, plus today's calendar events.
   > Summarize into a short, spoken-friendly morning briefing and write it to
   > `summary`.

3. **Optional — fully automated daily push:** create a *second* scheduled Quick
   agent that runs each morning, generates the same briefing, and writes it
   straight to `outputs/daily-summary.json`. Then "daily summary" is instant all
   day with no request round-trip.

**Test it:** say "daily summary" (or "morning briefing"). Quick fills in
`outputs/daily-summary.json` and Jarvis reads it.

---

## Adding another bridge path later

1. Add the task + trigger phrases to `bridge-template/task_registry.json`.
2. Add the same task to `QUICK_TASKS` in `app.js`.
3. Add a matching task section to the `voice-bridge-watcher` agent prompt in
   Amazon Quick.

The Python client and the app auto-read the registry — no other code changes
needed.
