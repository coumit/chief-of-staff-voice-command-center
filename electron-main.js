/* =============================================================================
 * Coco — Chief of Staff (Electron main process)
 * ---------------------------------------------------------------------------
 * - Opens the Coco HUD (index.html) in a real desktop window.
 * - Hosts the QUICK FILE-BRIDGE: writes a request JSON to a watched folder,
 *   waits for Quick to write a response file, and returns it to the renderer
 *   to speak. This sidesteps Quick's lack of a public chat API.
 * - Also relays Kiro CLI agent calls (so the C-suite agents still work).
 *
 * Open source stack: Electron (MIT). No cloud services of our own.
 * ==========================================================================*/

const { app, BrowserWindow, ipcMain, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFile, spawn } = require("child_process");

// --- Quick file-bridge config (matches the user's Quick watcher setup) ------
const BRIDGE_ROOT = process.env.COS_BRIDGE_ROOT || path.join(os.homedir(), "Documents", "CoS-Bridge");
const REQUESTS_DIR = path.join(BRIDGE_ROOT, "requests");
const RESPONSE_FILE = path.join(BRIDGE_ROOT, "responses", "response.json");
const BRIDGE_TIMEOUT_MS = Number(process.env.COCO_BRIDGE_TIMEOUT_MS || 360000); // 6 min

// --- Kiro CLI config --------------------------------------------------------
// The AI Developer / advisor features drive the Kiro CLI. We auto-detect it on
// the app's PATH; set KIRO_CLI to an absolute path to override.
const KIRO_CLI = process.env.KIRO_CLI || path.join(os.homedir(), ".local", "bin", "kiro-cli");
const KIRO_CWD = process.env.KIRO_CWD || os.homedir();
const KIRO_TIMEOUT_MS = Number(process.env.KIRO_TIMEOUT_MS || 120000);

// PATH a GUI-launched app should search (GUI apps inherit a minimal PATH).
const AGENT_PATH_DIRS = [
  path.join(process.env.HOME || "", ".local/bin"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  process.env.PATH || "",
].filter(Boolean);
const AGENT_ENV = Object.assign({}, process.env, { PATH: AGENT_PATH_DIRS.join(":") });

// Find an executable by name on our augmented PATH. Returns absolute path or "".
function findOnPath(name) {
  for (const dir of AGENT_PATH_DIRS) {
    if (!dir || dir.includes(":")) continue; // skip the raw PATH blob
    const p = path.join(dir, name);
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return "";
}

// Resolve the Kiro CLI. Returns { bin, label } or { error, install } with
// actionable install guidance when it isn't found.
function resolveAgentCli() {
  // Explicit path env var takes priority.
  if (KIRO_CLI && fs.existsSync(KIRO_CLI)) return { bin: KIRO_CLI, label: "Kiro CLI" };
  const found = findOnPath("kiro-cli");
  if (found) return { bin: found, label: "Kiro CLI" };

  return {
    error:
      "Kiro CLI not found. The AI Developer needs the Kiro CLI installed.\n\n" +
      "• Install Kiro CLI: https://kiro.dev/docs\n" +
      "• Or set KIRO_CLI to its absolute path.\n\n" +
      "After installing, restart the app.",
    install: true,
  };
}

// Build the argv for a one-shot, non-interactive Kiro CLI prompt:
//   kiro-cli chat "<prompt>" --no-interactive [--agent NAME]
function buildAgentArgs(message, agent) {
  const args = ["chat", message, "--no-interactive"];
  if (agent) args.push("--agent", agent);
  return args;
}

// --- Open Design config -----------------------------------------------------
// The `od` CLI starts the local daemon + opens the design web UI. When launched
// directly it binds to 7456 by default; we probe a small candidate list.
//
// Open Design ships WITH this app as a git submodule at third_party/open-design
// (built once by scripts/setup-open-design.sh). We resolve the bundled `od`
// binary from there by default; OD_BIN overrides it. In a packaged app the
// submodule is unpacked under Resources, so we also probe that location.
const OD_SUBMODULE_DIRS = [
  path.join(__dirname, "third_party", "open-design"),
  path.join(process.resourcesPath || "", "third_party", "open-design"),
  path.join(process.resourcesPath || "", "app.asar.unpacked", "third_party", "open-design"),
];
function resolveBundledOd() {
  for (const root of OD_SUBMODULE_DIRS) {
    if (!root) continue;
    const candidates = [
      path.join(root, "node_modules", ".bin", "od"),   // created by pnpm install
      path.join(root, "apps", "daemon", "bin", "od.mjs"), // direct entry (needs build)
    ];
    for (const c of candidates) {
      try { if (fs.existsSync(c)) return c; } catch {}
    }
  }
  // Fall back to the legacy per-user install location.
  return path.join(os.homedir(), "workspace", "open-design", "node_modules", ".bin", "od");
}
const OD_BIN = process.env.OD_BIN || resolveBundledOd();
const OD_DAEMON_URLS = (process.env.OD_DAEMON_URL
  ? [process.env.OD_DAEMON_URL]
  : ["http://127.0.0.1:7456", "http://127.0.0.1:57776", "http://127.0.0.1:50331"]);
const OD_NODE_BIN = process.env.OD_NODE_BIN ||
  path.join(os.homedir(), ".local", "bin");

let mainWindow = null;

function createWindow() {
  const win = new BrowserWindow({
    width: 1040,
    height: 940,
    backgroundColor: "#01060b",
    title: "CoS · Chief of Staff",
    // Neon CoS icon for the taskbar/window (Windows/Linux dev). On macOS the
    // Dock icon comes from the packaged .icns (build/icon.icns).
    icon: path.join(__dirname, process.platform === "win32"
      ? "build/icon.ico"
      : "build/icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow = win;
  win.loadFile(path.join(__dirname, "index.html"));
  win.on("closed", () => { if (mainWindow === win) mainWindow = null; });
  if (process.env.COCO_DEBUG) win.webContents.openDevTools({ mode: "detach" });

  // Safety net: if the renderer ever crashes or goes unresponsive (e.g. a GPU
  // compositing hiccup that blanks the window), reload it automatically so it
  // never gets stuck on a blank screen.
  win.webContents.on("render-process-gone", (_e, details) => {
    if (details && details.reason !== "clean-exit" && !win.isDestroyed()) {
      win.reload();
    }
  });
  win.webContents.on("unresponsive", () => { if (!win.isDestroyed()) win.reload(); });
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// =============================================================================
// IPC: QUICK FILE-BRIDGE
// =============================================================================
// renderer calls: window.coco.quickTask("daily-summary", {params})
// → writes request → polls response file → resolves { status, summary, ... }
ipcMain.handle("quick-task", async (_evt, task, params = {}) => {
  try {
    fs.mkdirSync(REQUESTS_DIR, { recursive: true });
    fs.mkdirSync(path.dirname(RESPONSE_FILE), { recursive: true });
  } catch (e) {
    return { error: `Could not create bridge folders: ${e.message}` };
  }

  // Note the current response mtime so we only accept a NEWER response.
  let lastModified = 0;
  try { lastModified = fs.statSync(RESPONSE_FILE).mtimeMs; } catch {}

  // 1) Write the request.
  const request = {
    task,
    requested_at: new Date().toISOString(),
    params: params || {},
  };
  const reqPath = path.join(REQUESTS_DIR, `request_${Date.now()}.json`);
  try {
    fs.writeFileSync(reqPath, JSON.stringify(request, null, 2));
  } catch (e) {
    return { error: `Could not write request: ${e.message}` };
  }

  // 2) Poll for a newer response (Quick picks up within ~5 min).
  const start = Date.now();
  while (Date.now() - start < BRIDGE_TIMEOUT_MS) {
    try {
      if (fs.existsSync(RESPONSE_FILE)) {
        const m = fs.statSync(RESPONSE_FILE).mtimeMs;
        if (m > lastModified) {
          const data = JSON.parse(fs.readFileSync(RESPONSE_FILE, "utf8"));
          return data;   // e.g. { status: "completed", summary: "..." }
        }
      }
    } catch {
      /* file mid-write; keep polling */
    }
    await new Promise((r) => setTimeout(r, 10000)); // 10s poll
  }
  return { error: "Timed out waiting for Quick to respond." };
});

// =============================================================================
// IPC: KIRO CLI (agents)
// =============================================================================
ipcMain.handle("kiro", async (_evt, message, agent) => {
  return new Promise((resolve) => {
    // Resolve which agent CLI is installed (Kiro CLI or Claude Code CLI). If
    // neither is present, return actionable install guidance instead of a
    // cryptic spawn failure.
    const cli = resolveAgentCli();
    if (cli.error) {
      return resolve({ error: cli.error, install: !!cli.install });
    }
    if (!fs.existsSync(KIRO_CWD)) {
      return resolve({ error: `Working directory not found: ${KIRO_CWD}. Set KIRO_CWD env var.` });
    }

    const args = buildAgentArgs(message, agent);
    const cliLabel = cli.label;

    execFile(cli.bin, args, { cwd: KIRO_CWD, env: AGENT_ENV, timeout: KIRO_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const raw = (stdout || stderr || "").toString();
        // strip ANSI + credits/time footer
        const clean = raw
          .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
          .split("\n")
          .filter((ln) => !/Credits:\s*[\d.]+.*Time:/.test(ln))
          .map((ln) => ln.replace(/^\s*>\s?/, ""))
          .join("\n")
          .trim();
        if (err && !clean) {
          // Surface a detailed reason: spawn error, timeout, or non-zero exit.
          // ENOENT means the resolved binary vanished/isn't runnable → guide install.
          if (err.code === "ENOENT") {
            return resolve({
              error:
                `${cliLabel} could not be launched (${cli.bin}). Reinstall it or ` +
                `set KIRO_CLI to the correct path.`,
              install: true,
            });
          }
          const detail = err.killed ? "timed out"
            : (err.code !== undefined ? `exited with code ${err.code}` : err.message);
          const errText = (stderr || "").toString().replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").trim();
          resolve({ error: `${cliLabel} ${detail}${errText ? `: ${errText.slice(0, 300)}` : ""}` });
        } else {
          resolve({ reply: clean || "No output.", agent: agent || "" });
        }
      });
  });
});

// =============================================================================
// IPC: OPEN DESIGN — launch the local daemon + design web UI
// ---------------------------------------------------------------------------
// "call my UX design shop" → start the `od` daemon (opens the Open Design web
// UI in the browser). If it's already running, we just report that.
// =============================================================================
const http = require("http");

// Resolve which candidate daemon URL is actually responding (or null).
function findLiveDaemon() {
  const probe = (url) => new Promise((res) => {
    try {
      const req = http.get(url + "/api/projects", { timeout: 1200 }, (r) => {
        r.resume();
        res(r.statusCode && r.statusCode < 500 ? url : null);
      });
      req.on("error", () => res(null));
      req.on("timeout", () => { req.destroy(); res(null); });
    } catch { res(null); }
  });
  return Promise.all(OD_DAEMON_URLS.map(probe)).then((r) => r.find(Boolean) || null);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Create a fresh Open Design project via the daemon API. Returns {id,name,url}.
function createDesignProject(baseUrl) {
  return new Promise((resolve, reject) => {
    const stamp = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const id = `coco-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}`;
    const name = `Coco Design Session — ${stamp.toLocaleString()}`;
    const payload = JSON.stringify({ id, name });
    const u = new URL(baseUrl + "/api/projects");
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
      timeout: 8000,
    }, (r) => {
      let body = "";
      r.on("data", (d) => (body += d));
      r.on("end", () => {
        try {
          const data = JSON.parse(body);
          if (data && data.project) resolve({ id: data.project.id, name: data.project.name, url: baseUrl });
          else reject(new Error((data && data.error && data.error.message) || "create failed"));
        } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timed out creating project")); });
    req.write(payload);
    req.end();
  });
}

// Kick off a design generation run in a project (daemon spawns its own agent).
function startDesignRun(baseUrl, projectId, brief) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ projectId, message: brief, currentPrompt: brief });
    const u = new URL(baseUrl + "/api/runs");
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
      timeout: 15000,
    }, (r) => {
      let body = "";
      r.on("data", (d) => (body += d));
      r.on("end", () => {
        try {
          const data = JSON.parse(body);
          if (data && data.runId) resolve(data);
          else reject(new Error((data && data.error && data.error.message) || "run failed to start"));
        } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timed out starting run")); });
    req.write(payload);
    req.end();
  });
}

ipcMain.handle("open-design", async (_evt, brief) => {
  if (!fs.existsSync(OD_BIN)) {
    return { error: `Open Design CLI not found at ${OD_BIN}. Set OD_BIN env var.` };
  }

  let base = await findLiveDaemon();
  let launched = false;

  // Start the daemon if it isn't already up.
  if (!base) {
    try {
      const env = Object.assign({}, process.env, {
        PATH: [OD_NODE_BIN, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", process.env.PATH || ""]
          .filter(Boolean).join(":"),
      });
      // Detached + --no-open: we open the browser ourselves after creating the
      // project, so the UI lands on the fresh session.
      const child = spawn(OD_BIN, ["--no-open"], {
        cwd: path.dirname(OD_BIN), env, detached: true, stdio: "ignore",
      });
      child.unref();
      launched = true;
    } catch (e) {
      return { error: `Could not launch Open Design: ${e.message}` };
    }
    // Wait for it to come up (up to ~15s).
    for (let i = 0; i < 15 && !base; i++) {
      await sleep(1000);
      base = await findLiveDaemon();
    }
    if (!base) return { error: "Open Design started but didn't come online in time." };
  }

  // Auto-create a fresh project for this session, then open the web UI.
  try {
    const project = await createDesignProject(base);
    const cleanBrief = (typeof brief === "string" ? brief.trim() : "");
    let run = null, runError = null;
    if (cleanBrief) {
      try {
        run = await startDesignRun(base, project.id, cleanBrief);
      } catch (e) {
        runError = e.message;
      }
    }
    try { await shell.openExternal(base); } catch {}
    return { ok: true, launched, already: !launched, url: base, project, brief: cleanBrief, run, runError };
  } catch (e) {
    // Daemon is up even if project creation failed — still open the UI.
    try { await shell.openExternal(base); } catch {}
    return { ok: true, launched, already: !launched, url: base, projectError: e.message };
  }
});

// =============================================================================
// IPC: READ LATEST REPORT OUTPUT (Quick bridge response file)
// ---------------------------------------------------------------------------
// The growth/finance summaries the user cares about are written by Quick to the
// bridge response file (and, if present, a per-task outputs folder). This lets
// the desktop app read the real, data-grounded summary + metrics directly
// instead of asking an agent to generate one from scratch.
// =============================================================================
ipcMain.handle("read-output", async (_evt, task) => {
  const wanted = (task || "").toLowerCase();
  const outputsDir = path.join(BRIDGE_ROOT, "outputs");

  // Per-task max cache ages from the Quick Voice Bridge spec (in hours).
  const MAX_CACHE_H = {
    "daily-summary": 12,   "growth-summary": 12,  "finance-summary": 12,
    "mom-update": 6,       "email-check": 1,      "calendar-check": 4,
    "booking-check": 6,    "system-status": 4,
  };

  const readJson = (p) => {
    try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
  };
  const mtime = (p) => { try { return fs.statSync(p).mtimeMs; } catch { return -1; } };
  const isFresh = (data) => {
    if (!data || !data.completed_at) return true;   // no timestamp → serve it
    const taskName = (data.task || "").toLowerCase();
    const maxH = MAX_CACHE_H[taskName];
    if (!maxH) return true;                         // unknown task → serve it
    const age = Date.now() - new Date(data.completed_at).getTime();
    return age < maxH * 3600000;
  };
  const shape = (data) => ({
    summary: data.summary || data.result || data.text || "",
    metrics: data.metrics || data.data || null,
    task: data.task || task || "",
    completed_at: data.completed_at || null,
  });

  // 1) DIRECT PATH: per-task file in outputs/ (e.g. "growth-summary.json").
  if (wanted) {
    const direct = [];
    direct.push(path.join(outputsDir, `${wanted}.json`));
    try {
      if (fs.existsSync(outputsDir)) {
        for (const f of fs.readdirSync(outputsDir)) {
          if (f.endsWith(".json")) direct.push(path.join(outputsDir, f));
        }
      }
    } catch {}
    let best = null, bestM = -1;
    for (const p of direct) {
      const m = mtime(p);
      if (m < 0 || m <= bestM) continue;
      const data = readJson(p);
      if (data && String(data.task || path.basename(p, ".json")).toLowerCase().includes(wanted)) {
        best = data; bestM = m;
      }
    }
    if (best) {
      if (isFresh(best)) return shape(best);
      return { error: "stale", staleAge: Math.round((Date.now() - new Date(best.completed_at).getTime()) / 60000) };
    }
  }

  // 2) SHARED FILE: only if its task matches.
  const shared = readJson(RESPONSE_FILE);
  if (shared) {
    if (!wanted || String(shared.task || "").toLowerCase().includes(wanted)) {
      if (isFresh(shared)) return shape(shared);
      return { error: "stale", staleAge: Math.round((Date.now() - new Date(shared.completed_at).getTime()) / 60000) };
    }
  }

  return { error: "No matching report output in the bridge folder yet." };
});

// =============================================================================
// NATIVE SPEECH RECOGNITION (macOS SFSpeechRecognizer via bundled helper)
// ---------------------------------------------------------------------------
// The cloud Web Speech API is unreliable inside Electron (it needs real
// Chrome + Google's backend). Instead we spawn a tiny native Swift helper that
// uses macOS on-device speech recognition and streams JSON lines. Events are
// forwarded to the renderer over the "speech-event" channel.
//
// The helper inherits Coco.app's TCC identity (mic + speech permissions), so
// the usage-description strings live in the packaged app's Info.plist.
// =============================================================================
let speechProc = null;

function speechHelperPath() {
  // Packaged: inside the app bundle's Resources. Dev: the ./native build.
  const packaged = path.join(process.resourcesPath || "", "native", "coco-speech");
  if (process.resourcesPath && fs.existsSync(packaged)) return packaged;
  return path.join(__dirname, "native", "coco-speech");
}

function sendSpeech(evt) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("speech-event", evt);
  }
}

ipcMain.handle("speech-start", async () => {
  if (process.platform !== "darwin") {
    return { error: "Native speech recognition is only available on macOS." };
  }
  if (speechProc) return { ok: true, already: true };

  const bin = speechHelperPath();
  if (!fs.existsSync(bin)) {
    return { error: `Speech helper not found at ${bin}` };
  }

  try {
    speechProc = spawn(bin, [], { stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    speechProc = null;
    return { error: `Could not start speech helper: ${e.message}` };
  }

  let buf = "";
  speechProc.stdout.on("data", (chunk) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try { sendSpeech(JSON.parse(line)); }
      catch { /* ignore partial/non-JSON lines */ }
    }
  });
  speechProc.stderr.on("data", (d) => {
    sendSpeech({ type: "error", message: d.toString().trim() });
  });
  speechProc.on("close", (code) => {
    sendSpeech({ type: "status", state: "stopped", code });
    speechProc = null;
  });

  return { ok: true };
});

// =============================================================================
// IPC: TEXT-TO-SPEECH via macOS `say` (reliable, no audio-unlock gesture needed)
// ---------------------------------------------------------------------------
// Web Speech `speechSynthesis` is unreliable inside Electron (silent unless a
// user gesture unlocks it, voices load async). The native `say` command always
// works and uses the same high-quality voices (Serena, etc.).
// =============================================================================
let sayProc = null;
const SAY_VOICE = process.env.COS_SAY_VOICE || "Ava (Premium)";

ipcMain.handle("say", async (_evt, text, opts = {}) => {
  if (process.platform !== "darwin") return { error: "say is macOS-only" };
  if (sayProc) { try { sayProc.kill("SIGTERM"); } catch {} sayProc = null; }
  const clean = String(text || "").slice(0, 4000);
  if (!clean.trim()) return { ok: true, empty: true };

  const voice = opts.voice || SAY_VOICE;
  const rate = String(opts.rate || 180);

  // Give the child a login-like environment; a hardened-runtime GUI app can
  // have a minimal env that affects CoreAudio routing for spawned processes.
  const env = Object.assign({}, process.env);

  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (!done) { done = true; sayProc = null; resolve(r); } };

    // Primary: say directly to the default audio device.
    try {
      sayProc = execFile("/usr/bin/say", ["-v", voice, "-r", rate, clean], { env },
        (err, stdout, stderr) => {
          if (err && err.killed) return finish({ ok: true, interrupted: true });
          if (err) {
            const detail = (stderr || err.message || "").toString().slice(0, 200);
            // Fallback A: no explicit voice.
            execFile("/usr/bin/say", ["-r", rate, clean], { env }, (e2) => {
              if (!e2) return finish({ ok: true, fallback: "no-voice" });
              // Fallback B: render to a temp AIFF then play with afplay.
              const tmp = path.join(app.getPath("temp"), `coco-say-${Date.now()}.aiff`);
              execFile("/usr/bin/say", ["-o", tmp, clean], { env }, (e3) => {
                if (e3) return finish({ error: `say failed: ${detail}` });
                execFile("/usr/bin/afplay", [tmp], { env }, () => {
                  try { fs.unlinkSync(tmp); } catch {}
                  finish({ ok: true, fallback: "afplay" });
                });
              });
            });
            return;
          }
          finish({ ok: true });
        });
    } catch (e) { finish({ error: e.message }); }
  });
});

ipcMain.handle("say-stop", async () => {
  if (sayProc) { try { sayProc.kill("SIGTERM"); } catch {} sayProc = null; }
  return { ok: true };
});

// =============================================================================
// IPC: PRODUCT BACKLOG (local JSON file the PM agent reads/updates)
// =============================================================================
const BACKLOG_FILE = path.join(BRIDGE_ROOT, "product-backlog.json");

function readBacklog() {
  try { return JSON.parse(fs.readFileSync(BACKLOG_FILE, "utf8")); }
  catch { return { items: [] }; }
}
function writeBacklog(data) {
  try {
    fs.mkdirSync(path.dirname(BACKLOG_FILE), { recursive: true });
    fs.writeFileSync(BACKLOG_FILE, JSON.stringify(data, null, 2));
    return true;
  } catch { return false; }
}

ipcMain.handle("backlog-list", async () => readBacklog());

ipcMain.handle("backlog-add", async (_evt, text) => {
  const t = String(text || "").trim();
  if (!t) return { error: "empty item" };
  const data = readBacklog();
  if (!Array.isArray(data.items)) data.items = [];
  data.items.push({ text: t, done: false, added_at: new Date().toISOString() });
  if (!writeBacklog(data)) return { error: "could not write backlog" };
  return { ok: true, count: data.items.length };
});

ipcMain.handle("speech-stop", async () => {
  if (speechProc) {
    try { speechProc.kill("SIGTERM"); } catch {}
    speechProc = null;
  }
  return { ok: true };
});

app.on("before-quit", () => {
  if (speechProc) { try { speechProc.kill("SIGTERM"); } catch {} speechProc = null; }
});
