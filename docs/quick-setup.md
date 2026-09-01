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

## 0. Prerequisite: the file-bridge

Do this once before setting up any path.

```bash
# Copy the default bridge into place (default location shown)
cp -R docs/bridge-template ~/Documents/CoS-Bridge
export COS_BRIDGE_ROOT=~/Documents/CoS-Bridge
```

In **Amazon Quick**, create a scheduled agent named **`voice-bridge-watcher`**
that polls `~/Documents/CoS-Bridge/requests/` every 5 minutes. Its job for every
request file is:

1. Read the `task` field.
2. Run the matching task section below.
3. Write the result to **both** `responses/response.json` and
   `outputs/<task>.json` using the response schema in `voice-bridge-spec.md`.
4. Delete the request file.

The task list and trigger phrases are defined in
`bridge-template/task_registry.json` — keep the agent's tasks in sync with it.

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
