/* =============================================================================
 * Command Center — voice-activated HUD assistant ("Son of Anton")
 * ---------------------------------------------------------------------------
 * - Wake word + push-to-talk via the Web Speech API (SpeechRecognition).
 * - Jarvis-style spoken replies via SpeechSynthesis (prefers a British male
 *   voice, e.g. macOS "Daniel"). NOTE: this is a Jarvis-*style* voice, not the
 *   copyrighted film voice.
 * - The central core GLOW ebbs and flows with the voice: while speaking, an
 *   amplitude envelope drives the core --glow and the waveform; while
 *   listening, the live mic input drives the waveform.
 * - A tiny command router maps spoken phrases to actions (extend freely).
 * ==========================================================================*/

const ASSISTANT_NAME = "Jarvis";
const OWNER_NAME = "there";
const WAKE_WORDS = ["hey jarvis", "jarvis", "hey coco", "coco", "chief of staff"];

// --- DOM refs ---------------------------------------------------------------
const body = document.body;
const statusText = document.getElementById("statusText");
const listeningText = document.getElementById("listeningText");
const micBtn = document.getElementById("micBtn");
const logEl = document.getElementById("log");
const canvas = document.getElementById("waveform");
const ctx = canvas.getContext("2d");
const core = document.querySelector(".dial-core");
const teleUptime = document.getElementById("teleUptime");
const teleLoad = document.getElementById("teleLoad");
const teleTemp = document.getElementById("teleTemp");

// --- Reveal-after-ready: keep the UI hidden until styles + the dial image are
// loaded and the first layout has settled, so a cold launch never shows a
// half-rendered/imageless flash. Fallback timers guarantee it always reveals.
(function revealWhenReady() {
  let revealed = false;
  const reveal = () => {
    if (revealed) return; revealed = true;
    requestAnimationFrame(() => document.body.classList.add("app-ready"));
  };
  const afterLoad = () => {
    // Wait for the dial backdrop image to decode, then reveal.
    const img = new Image();
    img.onload = reveal; img.onerror = reveal;
    img.src = "assets/hud-dial.png";
    // Safety: reveal regardless within 1.2s so we never stay blank.
    setTimeout(reveal, 1200);
  };
  if (document.readyState === "complete") afterLoad();
  else window.addEventListener("load", afterLoad, { once: true });
  // Absolute backstop.
  setTimeout(reveal, 2500);
})();

// --- State ------------------------------------------------------------------
let listening = false;
let speaking = false;
let micGateUntil = 0;     // ignore mic input until this timestamp (set after Coco speaks)
let glow = 0.25;          // current core glow (0..1), smoothed each frame
let targetGlow = 0.25;    // where glow is heading
let micAnalyser = null;   // AnalyserNode for live mic waveform
let micData = null;       // Uint8Array for mic time-domain samples
let audioCtx = null;

// Build the rotating dial ticks (36 around the ring). The transform-origin is
// set dynamically so ticks stay on the ring as the wheel scales responsively.
const tickWrap = document.getElementById("dialTicks");
(function buildTicks() {
  for (let i = 0; i < 36; i++) {
    const t = document.createElement("i");
    t.dataset.deg = String(i * 10);
    if (i % 5 === 0) t.style.opacity = "1";
    else t.style.opacity = String(0.35 + Math.random() * 0.4);
    tickWrap.appendChild(t);
  }
})();
function layoutTicks() {
  if (!tickWrap) return;
  const h = tickWrap.getBoundingClientRect().height;
  if (!h) return;
  const radius = h / 2 - 2;   // tick sits 2px from the top edge
  tickWrap.querySelectorAll("i").forEach((t) => {
    t.style.transformOrigin = `50% ${radius}px`;
    t.style.transform = `rotate(${t.dataset.deg}deg)`;
  });
}
layoutTicks();
window.addEventListener("resize", layoutTicks);
window.addEventListener("load", layoutTicks);
setTimeout(layoutTicks, 200);   // after fonts/layout settle

// --- Logging ----------------------------------------------------------------
function log(text, who = "a") {
  const line = document.createElement("div");
  line.className = who;
  line.innerHTML =
    who === "u" ? `<span class="u">&gt; ${escapeHtml(text)}</span>`
    : who === "muted" ? `<span class="muted">${escapeHtml(text)}</span>`
    : `<span class="a">${ASSISTANT_NAME}: ${escapeHtml(text)}</span>`;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
/** Pick a random line from an array (for varied, non-repetitive replies). */
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

/** Time-of-day greeting: Good morning / afternoon / evening. */
function greetingForTime() {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

// --- Agent handoff visual ---------------------------------------------------
// Spin the top-right reactor + highlight the targeted agent while Coco is
// "handing off" to a specialist (finance/ux/pm/security/quick).
let handoffTimer = null;
function beginHandoff(agentKey, caption) {
  document.body.classList.add("handoff");
  const cap = document.getElementById("reactorCaption");
  if (cap && caption) cap.textContent = caption;
  document.querySelectorAll(".agent-item").forEach((el) => {
    el.classList.toggle("active", el.getAttribute("data-agent") === agentKey);
  });
  if (handoffTimer) clearTimeout(handoffTimer);
}
function endHandoff() {
  if (handoffTimer) clearTimeout(handoffTimer);
  // Let the spin linger briefly so it reads as a real handoff, then settle.
  handoffTimer = setTimeout(() => {
    document.body.classList.remove("handoff");
    document.body.classList.remove("dev-active");
    document.body.classList.remove("calendar-active");
    const cap = document.getElementById("reactorCaption");
    if (cap) cap.textContent = "C-SUITE";
    document.querySelectorAll(".agent-item.active").forEach((el) => el.classList.remove("active"));
  }, 600);
}

// Light up the middle-left AI Developer ring while Kiro is engaged.
function beginDevHandoff() { document.body.classList.add("dev-active"); }

// --- Canvas sizing ----------------------------------------------------------
function sizeCanvas() {
  const r = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.floor(r.width * devicePixelRatio));
  canvas.height = Math.max(1, Math.floor(r.height * devicePixelRatio));
}
window.addEventListener("resize", sizeCanvas);
sizeCanvas();

// =============================================================================
// TEXT-TO-SPEECH — natural American female voice (Ava Premium)
// =============================================================================
let cachedVoice = null;
function pickVoice() {
  const voices = speechSynthesis.getVoices();
  if (!voices.length) return null;
  // Prefer the natural American-female voices installed on this Mac
  // (Ava Premium/Enhanced), then other US female voices. (In the desktop app,
  // TTS actually goes through the native `say` command with "Ava (Premium)";
  // this list only governs the browser-mode Web Speech fallback.)
  const prefs = [
    (v) => /ava/i.test(v.name) && /premium/i.test(v.name),
    (v) => /ava/i.test(v.name) && /enhanced/i.test(v.name),
    (v) => /ava/i.test(v.name) && /en[-_]?US/i.test(v.lang),
    (v) => /(allison|susan|samantha|zoe|nicky)/i.test(v.name) && /(premium|enhanced)/i.test(v.name),
    (v) => /samantha/i.test(v.name) && /en[-_]?US/i.test(v.lang),
    (v) => /google us english/i.test(v.name),
    (v) => /en[-_]?US/i.test(v.lang) && !/male|fred|albert|junior|ralph|eddy|reed|rocko|grandpa|bad|boing|bubbles|bells|cellos|organ|zarvox|trinoids|whisper|wobble|jester|bahh|superstar/i.test(v.name),
    (v) => /en[-_]?US/i.test(v.lang),
    (v) => /^en/i.test(v.lang),
  ];
  for (const test of prefs) {
    const found = voices.find(test);
    if (found) return found;
  }
  return voices[0];
}
function refreshVoice() {
  cachedVoice = pickVoice();
  const diag = document.getElementById("diagText");
  if (diag) {
    const n = speechSynthesis.getVoices().length;
    diag.textContent = cachedVoice
      ? `voice: ${cachedVoice.name} (${cachedVoice.lang}) · ${n} available`
      : `voices: ${n} (none matched)`;
  }
}
speechSynthesis.onvoiceschanged = refreshVoice;
cachedVoice = pickVoice();
// getVoices() is often empty on first paint in Chrome; poll briefly until ready.
(function waitForVoices(tries = 0) {
  if (speechSynthesis.getVoices().length || tries > 20) { refreshVoice(); return; }
  setTimeout(() => waitForVoices(tries + 1), 150);
})();

/**
 * Speak text with the Jarvis-style voice AND drive the core glow + waveform
 * from a synthesized amplitude envelope (SpeechSynthesis doesn't expose raw
 * PCM, so we simulate a natural speaking envelope keyed to word boundaries).
 */
// Unlock the TTS engine on a real user gesture. Browsers/Electron block
// speechSynthesis until the user interacts. resume() on a gesture is enough to
// keep the engine live for later programmatic speech.
let audioUnlocked = false;
function unlockAudio() {
  try { if (audioCtx && audioCtx.state === "suspended") audioCtx.resume(); } catch {}
  try { speechSynthesis.resume(); } catch {}
  audioUnlocked = true;
}

// True when running inside the Electron desktop shell.
const IN_ELECTRON_TTS = typeof window !== "undefined" && window.coco && window.coco.isElectron && window.coco.say;

function speak(text) {
  // Desktop app: use native macOS `say` (reliable — no audio-unlock gesture
  // needed, unlike Web Speech inside Electron). Drives the glow envelope on a
  // timer and settles when `say` finishes.
  if (IN_ELECTRON_TTS) return speakNative(text);
  return speakWeb(text);
}

// Native `say`-backed speak with the same glow/mic-gating behavior as before.
function speakNative(text) {
  return new Promise((resolve) => {
    log(text, "a");
    let settled = false;
    speaking = true;
    // Cancel any pending mic-resume so it can't fire mid-speech and let the
    // recognizer hear Coco's own voice.
    if (typeof micResumeTimer !== "undefined" && micResumeTimer) { clearTimeout(micResumeTimer); micResumeTimer = null; }
    body.classList.add("speaking");
    const envTimer = setInterval(() => { targetGlow = 0.45 + Math.random() * 0.55; }, 90);
    const finish = () => {
      if (settled) return;
      settled = true;
      clearInterval(envTimer);
      speaking = false;
      body.classList.remove("speaking");
      targetGlow = 0.22;
      micGateUntil = Date.now() + 1200;
      clearSilenceTimer();
      scheduleMicResume();
      resolve();
    };
    try {
      window.coco.say(text).then((r) => {
        if (r && r.error) log(`(voice: ${r.error})`, "muted");
        else if (r && r.fallback) log(`(voice via ${r.fallback})`, "muted");
        finish();
      }, finish);
    } catch { finish(); }
  });
}

function speakWeb(text) {
  return new Promise((resolve) => {
    if (!("speechSynthesis" in window)) { log(text); resolve(); return; }
    // Only cancel if something is actually speaking/queued. Cancelling when
    // idle (or firing a second speak on the same utterance) is what caused the
    // "canceled" error in Chrome.
    let didCancel = false;
    if (speechSynthesis.speaking || speechSynthesis.pending) {
      speechSynthesis.cancel();
      didCancel = true;
    }
    const u = new SpeechSynthesisUtterance(text);
    const v = cachedVoice || pickVoice();
    if (v) u.voice = v;                       // leave unset -> browser default if none matched
    u.lang = (v && v.lang) || "en-US";
    u.rate = 1.0;
    u.pitch = 1.0;
    u.volume = 1;

    let envTimer = null;
    let settled = false;
    const startEnvelope = () => {
      speaking = true;
      body.classList.add("speaking");
      envTimer = setInterval(() => { targetGlow = 0.45 + Math.random() * 0.55; }, 90);
    };
    const stopEnvelope = () => {
      if (settled) return;
      settled = true;
      if (envTimer) clearInterval(envTimer);
      envTimer = null;
      speaking = false;
      body.classList.remove("speaking");
      targetGlow = 0.22;
      // Keep the mic gated for a short tail so trailing echo of Coco's own
      // voice (or buffered audio) can't re-trigger the last command.
      micGateUntil = Date.now() + 1200;
      // Also drop any speech captured while she was talking.
      clearSilenceTimer();
      // Debounced resume: only bring the mic back once she's truly done (no new
      // utterance started within the tail). This prevents resuming between the
      // "On it" ack and the actual briefing.
      scheduleMicResume();
      resolve();
    };

    u.onstart = startEnvelope;
    u.onboundary = () => { targetGlow = 0.6 + Math.random() * 0.4; };
    u.onend = stopEnvelope;
    u.onerror = (e) => {
      // "canceled"/"interrupted" are normal when we intentionally stop speech;
      // don't surface them as errors. Log anything else.
      const err = e && e.error;
      if (err && err !== "canceled" && err !== "interrupted") {
        log(`(speech error: ${err})`, "muted");
      }
      stopEnvelope();
    };

    log(text, "a");
    // Chrome sometimes needs a resume() if a prior session left it paused.
    try { if (speechSynthesis.paused) speechSynthesis.resume(); } catch {}
    // If we just cancelled a prior utterance, give the engine a beat before
    // speaking — cancel-then-speak too fast can leave the new one silent.
    const fire = () => {
      try {
        speechSynthesis.resume();
        speechSynthesis.speak(u);
      } catch (e) { log(`(speech error: ${e && e.message ? e.message : e})`, "muted"); stopEnvelope(); }
    };
    if (didCancel) setTimeout(fire, 120); else fire();
  });
}

// =============================================================================
// SPEECH RECOGNITION — wake word + commands
// =============================================================================
// Detect Electron up front so we can choose the reliable native recognizer.
const IN_ELECTRON_SR = typeof window !== "undefined" && window.coco && window.coco.isElectron;

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let recog = null;
// In Electron we use the native macOS recognizer (window.coco.speech*), which
// is far more reliable than the cloud Web Speech API. In a browser we fall back
// to the Web Speech API (needs Chrome/Edge).
let recogSupported = IN_ELECTRON_SR || !!SR;
let useNativeSR = IN_ELECTRON_SR;
let nativeUnsub = null;

// --- Silence-based auto-submit ---------------------------------------------
// If you stop speaking for SILENCE_MS, whatever was heard is submitted
// automatically (so you don't have to wait for the engine's "final" event or
// tap anything). Reset on every new partial; cancelled once we submit.
const SILENCE_MS = 1500;
let silenceTimer = null;
let countdownTimer = null;
let pendingSpeech = "";
let lastHeardText = "";

// Called on every partial. We only treat it as "still speaking" (and reset the
// countdown) when the transcript actually GROWS/CHANGES. macOS often keeps
// emitting partials with identical text during a pause; those must NOT keep the
// timer alive, or auto-submit would never trigger. Once the text stops
// changing for SILENCE_MS, we submit.
function noteSpeech(text) {
  // Ignore mic input while Coco is speaking (and briefly after) so her own
  // voice doesn't reset the timer or get auto-submitted.
  if (micGated()) return;
  const t = (text || "").trim();
  if (!t) return;
  pendingSpeech = t;
  const changed = t !== lastHeardText;
  lastHeardText = t;
  // Start the timer if it isn't running; reset it only when the text changed.
  if (changed || !silenceTimer) {
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => {
      const phrase = pendingSpeech;
      silenceTimer = null;
      if (phrase) submitSpokenText(phrase);
    }, SILENCE_MS);
  }
}
function clearSilenceTimer() {
  if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
  pendingSpeech = "";
  lastHeardText = "";
}

function setDiag(text) {
  const diag = document.getElementById("diagText");
  if (diag) diag.textContent = text;
}

// Show live speech in the Ask box so you can see what Coco is hearing, and
// submit it through the same path as a typed question when the phrase is final.
// NOTE: we intentionally do NOT write recognized speech into the Ask box — the
// live transcript shows in the diagnostics line ("heard: …") and the finalized
// command appears in the log as your "> …" user line. Keeping the Ask box for
// typing only prevents Coco's spoken/partial text from landing in the input.
function showPartialInAsk(_text) { /* no-op by design */ }
// While Coco is speaking (and for a short tail afterward) we ignore mic input
// so her own voice / echo can't re-trigger the same command — this is what was
// causing the briefing to cycle and repeat.
function micGated() {
  return speaking || Date.now() < micGateUntil;
}

function submitSpokenText(text) {
  const clean = text.trim();
  if (!clean) return;
  if (micGated()) { clearSilenceTimer(); return; }   // don't route Coco's own speech
  // Cancel any pending silence timer so we don't submit the same phrase twice
  // (e.g. the engine's "final" arrives right as the pause timer fires).
  clearSilenceTimer();
  // Turn the mic off while Coco works on / speaks the answer, so she isn't
  // listening over herself. It resumes automatically once she's done.
  suspendMic();
  // Route it exactly like a typed/asked command. (We do not touch the Ask box;
  // the command shows in the log as your "> …" line.)
  handleTranscript(clean.toLowerCase());
}

// ---- Native (Electron/macOS) recognition ----------------------------------
function startNativeRecognition() {
  if (!useNativeSR) return;
  if (!nativeUnsub) {
    nativeUnsub = window.coco.onSpeech((evt) => {
      if (!evt) return;
      // Only the transcript events are gated while Coco speaks; status/error
      // (including an unexpected "stopped") must always be handled.
      if (evt.type === "partial") {
        if (micGated()) return;
        if (evt.text) { setDiag(`heard: "${evt.text.trim()}"`); showPartialInAsk(evt.text); noteSpeech(evt.text); }
      } else if (evt.type === "final") {
        if (micGated()) return;
        if (evt.text && evt.text.trim()) submitSpokenText(evt.text);
      } else if (evt.type === "status") {
        if (evt.state === "listening") setDiag("listening\u2026 (speak now)");
        else if (evt.state === "stopped") {
          // The helper exited (e.g. macOS restarted it after a permission
          // change). If the user still has the mic on and Coco isn't mid-reply,
          // auto-restart so voice input self-heals instead of going dead.
          if (listening && !micSuspended) {
            setDiag("reconnecting voice\u2026");
            setTimeout(() => { if (listening && !micSuspended) window.coco.speechStart(); }, 800);
          }
        }
      } else if (evt.type === "error") {
        log(`Voice input: ${evt.message}`, "muted");
      }
    });
  }
  window.coco.speechStart().then((res) => {
    if (res && res.error) {
      log(`Voice input unavailable: ${res.error}`, "muted");
      setListening(false);
    }
  });
}
function stopNativeRecognition() {
  if (useNativeSR && window.coco) window.coco.speechStop();
}

// Temporarily suspend the mic while Coco is working/speaking, then bring it
// back automatically once she's done — so she isn't "listening" over herself.
// `listening` (the UI/session flag) stays true so we know to resume.
let micSuspended = false;
function suspendMic() {
  if (!listening || micSuspended) return;
  micSuspended = true;
  clearSilenceTimer();
  if (useNativeSR) stopNativeRecognition();
  else if (recog) { try { recog.stop(); } catch {} }
  setDiag("one moment\u2026");
}
function resumeMic() {
  if (!listening || !micSuspended) return;
  micSuspended = false;
  if (useNativeSR) startNativeRecognition();
  else if (recog) { try { recog.start(); } catch {} }
  setDiag("listening\u2026 (speak now)");
}
// Resume the mic ~1.4s after speech ends, unless Coco starts speaking again
// (e.g. the ack is followed by the real answer). Each speak() end reschedules.
let micResumeTimer = null;
function scheduleMicResume() {
  if (micResumeTimer) clearTimeout(micResumeTimer);
  micResumeTimer = setTimeout(() => {
    micResumeTimer = null;
    if (!speaking) resumeMic();
  }, 1400);
}

// ---- Web Speech API (browser fallback) ------------------------------------
function initRecognition() {
  if (useNativeSR || !SR) return;
  recog = new SR();
  recog.lang = "en-US";
  recog.continuous = true;
  recog.interimResults = true;

  recog.onresult = (e) => {
    if (micGated()) return;   // ignore results while Coco is speaking
    let finalText = "", interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      if (res.isFinal) finalText += res[0].transcript;
      else interim += res[0].transcript;
    }
    if (interim) { setDiag(`heard: "${interim.trim()}"`); showPartialInAsk(interim); noteSpeech(interim); }
    if (finalText.trim()) submitSpokenText(finalText);
  };
  recog.onstart = () => setDiag("listening\u2026 (speak now)");
  recog.onend = () => { if (listening) { try { recog.start(); } catch {} } };
  recog.onerror = (e) => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      setListening(false);
      log("Microphone access denied. Enable it to use voice.", "muted");
    } else if (e.error === "network") {
      setListening(false);
      log("Speech recognition needs Google Chrome (the browser engine here can't reach the speech service). Try the desktop app or type your command.", "muted");
    } else if (e.error !== "no-speech" && e.error !== "aborted") {
      log(`Voice input error: ${e.error}`, "muted");
    }
  };
}
initRecognition();

async function startMicAnalyser() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const src = audioCtx.createMediaStreamSource(stream);
    micAnalyser = audioCtx.createAnalyser();
    micAnalyser.fftSize = 512;
    micData = new Uint8Array(micAnalyser.frequencyBinCount);
    src.connect(micAnalyser);
  } catch {
    log("Could not access the microphone.", "muted");
  }
}

// =============================================================================
// KIRO AGENTS — Coco drives the Kiro CLI via her local backend (coco_server.py)
// ---------------------------------------------------------------------------
// You speak → Coco transcribes → backend runs `kiro-cli chat "<prompt>"
// --no-interactive [--agent NAME]` → Coco speaks the reply. Fully local.
// =============================================================================
const COCO_BACKEND = "http://127.0.0.1:4610";
// True when running inside the Electron desktop shell (preload exposes window.coco).
const IN_ELECTRON = typeof window !== "undefined" && window.coco && window.coco.isElectron;

// =============================================================================
// QUICK VOICE BRIDGE — task registry (per "Quick Voice Bridge" spec)
// ---------------------------------------------------------------------------
// 8 tasks, each with trigger phrases. Coco matches the transcript against these
// (longest phrase wins, so "growth summary" beats "summary"), then routes the
// task through the file-bridge (write request → poll response → speak summary).
// =============================================================================
const QUICK_TASKS = {
  "daily-summary":   { label: "daily summary",
    phrases: ["daily summary", "what happened today", "morning briefing", "day summary"] },
  // NOTE: "growth-summary" (Chief Growth Officer) is intentionally excluded
  // from this build — the CGO role is not offered in this command center.
  "finance-summary": { label: "finance briefing",
    phrases: ["finance summary", "call the cfo", "cost report", "how much are we spending", "aws costs", "cfo", "what are we spending", "chief financial officer", "finance report", "finance"] },
  "mom-update":      { label: "family update",
    phrases: ["mom update", "kids update", "what's going on with the kids", "school update", "family update", "kids calendar", "what do the kids have this week"] },
  "email-check":     { label: "email check",
    phrases: ["check my email", "what's in my inbox", "any new emails", "inbox check", "email update", "check email"] },
  "calendar-check":  { label: "schedule",
    phrases: ["what's on my schedule", "any meetings today", "what's today look like", "calendar check", "my schedule", "schedule"] },
  "booking-check":   { label: "bookings update",
    phrases: ["any new bookings", "check bookings", "booking requests", "booking update", "new clients", "bookings"] },
  "system-status":   { label: "system status",
    phrases: ["how are my agents", "system status", "agent status", "are things running", "system check"] },
};

/** Match a transcript to a Quick task by trigger phrase. Longest phrase that is
 *  a substring wins, so specific phrases beat generic ones. Returns
 *  { task, label } or null. */
function matchQuickTask(text) {
  const t = " " + text.toLowerCase().trim() + " ";
  let best = null, bestLen = 0;
  for (const [task, cfg] of Object.entries(QUICK_TASKS)) {
    for (const p of cfg.phrases) {
      if (t.includes(p.toLowerCase()) && p.length > bestLen) {
        best = { task, label: cfg.label }; bestLen = p.length;
      }
    }
  }
  return best;
}

// Per-task hint describing what the user must connect Amazon Quick to. Used to
// tailor the setup guidance so each capability points at the right data source.
const QUICK_SOURCE_HINT = {
  "finance-summary": "point Quick at your financial-report emails",
  "daily-summary":   "connect Quick to your daily work email (and calendar)",
  "calendar-check":  "connect Quick to your calendar",
  "email-check":     "connect Quick to your email inbox",
  "booking-check":   "connect Quick to the mailbox that receives booking emails",
  "mom-update":      "connect Quick to your family calendar and school emails",
  "system-status":   "let Quick read your agents' activity feed",
};

// Guide the user through setting up Amazon Quick + the file-bridge when it
// hasn't been set up yet (Quick has never written a response). Spoken message
// stays short; the log carries the actionable steps + paths. The hint is
// tailored to the specific task (CFO vs daily summary vs calendar, etc.).
function guideBridgeSetup(label, status, task) {
  const root = (status && status.bridgeRoot) || "~/Documents/CoS-Bridge";
  const hint = QUICK_SOURCE_HINT[task] || "connect Quick to the relevant data source";
  log(`Amazon Quick isn't set up yet, so I can't get your ${label}.`, "a");
  log("To enable Quick briefings (CFO, daily summary, calendar, etc.):", "muted");
  log("1. Install Amazon Quick (Amazon Quick Suite): https://quick.amazon.com", "muted");
  log(`2. Create a scheduled Quick agent named \u201cvoice-bridge-watcher\u201d that watches ${root}/requests/, and have Quick CREATE the responses/ and outputs/ folders and write results there.`, "muted");
  log(`3. For this \u201c${label}\u201d, ${hint} (the ${task} task).`, "muted");
  log("Full copy-paste instructions to hand Quick are in docs/quick-setup.md (\u201cGive these instructions to Quick\u201d).", "muted");
  return speak(
    `Amazon Quick isn't set up yet, so I can't pull your ${label}. ` +
    `You'll need to install Amazon Quick and create the bridge — for this, ${hint}. ` +
    `I've put the step-by-step setup, including the exact instructions to give Quick, in the log and in the quick-setup guide.`
  );
}

// Ask Amazon Quick via the local FILE-BRIDGE (Electron main writes a request
// file, Quick answers within ~5 min, we speak the summary). Electron-only.
async function askQuickBridge(task, label) {
  if (!IN_ELECTRON) {
    return speak("The Quick bridge only works in the Coco desktop app.");
  }
  setStatus("WORKING");
  beginHandoff("quick", (label || "QUICK").toUpperCase());

  // INSTANT PATH: read the cached per-task output first (Quick writes
  // outputs/<task>.json). If it's present and fresh, speak it immediately —
  // no waiting on Quick's 5-minute poll cycle.
  try {
    const cached = await window.coco.readOutput(task);
    if (cached && !cached.error && cached.summary) {
      const intro = pick([`Here's your ${label}.`, `Right then — your ${label}.`]);
      log(cached.summary, "a");
      if (cached.metrics) log(`data: ${JSON.stringify(cached.metrics)}`, "muted");
      // One combined utterance so a back-to-back speak() can't cancel itself
      // (which left a gap where the mic caught fragments and overlapped).
      return speakLong(`${intro} ${cached.summary}`);
    }
    if (cached && cached.error === "stale") {
      log(`[quick] ${task} cache is ${cached.staleAge || "?"}min old; requesting fresh.`, "muted");
    }
  } catch (e) {
    log(`[quick] could not read cache: ${e && e.message ? e.message : e}`, "muted");
  }

  // SETUP CHECK: if Amazon Quick has never produced a response, the bridge
  // isn't set up. Guide the user instead of writing a request that will just
  // time out after several minutes.
  try {
    const status = await window.coco.bridgeStatus();
    if (status && !status.ready) {
      return guideBridgeSetup(label, status, task);
    }
  } catch (e) {
    log(`[quick] could not check bridge status: ${e && e.message ? e.message : e}`, "muted");
  }

  // FRESH PATH: nothing cached (or stale) — request it and wait for Quick.
  setStatus("REQUESTING");
  speak(`Requesting your ${label} from Amazon Quick. This can take a few minutes \u2014 I'll let you know the moment it's ready.`);
  try {
    const data = await window.coco.quickTask(task, {});
    if (!data || data.error) {
      log((data && data.error) || "No response.", "muted");
      return speak(`I couldn't get your ${label} from Quick. ${(data && data.error) || ""}`);
    }
    if (data.status && data.status !== "completed") {
      return speak(`Quick reported status: ${data.status}.`);
    }
    const summary = data.summary || data.result || data.text || "";
    if (!summary) return speak("Quick responded, but there was no summary text.");
    log(summary, "a");
    // Per spec: `data` holds structured metrics for UI display. Show it in the log.
    if (data.data && typeof data.data === "object" && Object.keys(data.data).length) {
      log(`data: ${JSON.stringify(data.data)}`, "muted");
    }
    return speakLong(summary);
  } catch (e) {
    log(`Quick bridge error: ${e}`, "muted");
    return speak("The Quick bridge ran into a problem.");
  }
}

// Spoken aliases → actual Kiro agent names (from `kiro-cli agent list`).
const AGENT_ALIASES = {
  "default": "kiro_default",
  "help": "kiro_help",
  "planner": "kiro_planner",
  "plan": "kiro_planner",
  "crew": "kirocrew",
  "kirocrew": "kirocrew",
  "research": "kirocrew-research",
  "researcher": "kirocrew-research",
  "knowledge": "kirocrew-knowledge",
  // C-suite agents
  // NOTE: Chief Growth Officer ("growth") and Marketing & Sales ("marketing"/
  // "sales") are intentionally excluded from this build and are NOT mapped.
  "finance": "finance-agent",
  "finance agent": "finance-agent",
  "design": "ux-design-shop",
  "design shop": "ux-design-shop",
  "ux": "ux-design-shop",
  "pm": "pm-agent",
  "pm agent": "pm-agent",
  "product manager": "pm-agent",
  "product": "pm-agent",
  "security": "chief-security-officer",
  "security officer": "chief-security-officer",
  "chief security officer": "chief-security-officer",
  "cso": "chief-security-officer",
};

// Map a report kind to its Kiro agent + a grounding prompt (used in the desktop
// app, which has no Flask backend and drives the Kiro CLI directly via IPC).
const REPORT_AGENTS = {
  // Growth (Chief Growth Officer) intentionally excluded from this build.
  finance: {
    agent: "finance-agent",
    prompt: "Give me today's finance briefing: top AWS cost drivers (infra + LLM spend) with 2-3 recommendations to control spend. Ground it in the cost report data.",
  },
};

/** Launch the Open Design shop: start the local daemon + open its web UI so
 *  you can spin up a new design project. Electron-only (needs filesystem/spawn). */
/** Pull a design brief out of a spoken command, e.g.
 *  "call my design shop, let's start a new design of a cruise landing page"
 *  → "a cruise landing page". Returns "" if no explicit brief was given. */
function extractDesignBrief(cmd) {
  // 1) Remove the shop trigger words so "design shop"/"design studio" don't get
  //    mistaken for the brief lead-in.
  let s = cmd
    .replace(/\b(ux|u x)\b/gi, " ")
    .replace(/\bopen\s+design\b/gi, " ")
    .replace(/\bdesign\s+(shop|studio|team)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  // 2) Take everything after a "start/new/let's design/create" lead-in.
  const m = s.match(/\b(?:start(?:\s+a)?\s+new\s+design|new\s+design|start\s+a\s+design|design(?:\s+me)?|create(?:\s+a)?\s+design|let'?s\s+design|build|make)\b\s*(?:of|for|:|on)?\s*(.*)$/i);
  let brief = (m && m[1]) ? m[1] : "";
  brief = brief.trim()
    .replace(/^(a|an|the|some|new)\s+/i, "")
    .replace(/[\s.,;:!?]+$/, "")
    .trim();
  return brief.length >= 3 ? brief : "";
}

async function launchDesignShop(brief) {
  setStatus("WORKING");
  beginHandoff("ux", "DESIGN");
  if (!IN_ELECTRON) {
    return speak("The design shop can only be launched from the Coco desktop app.");
  }
  speak(brief
    ? "Opening your design shop and starting a new design now."
    : "Opening your design shop now.");
  try {
    const res = await window.coco.openDesign(brief);
    if (!res || res.error) {
      log(`[design] ${(res && res.error) || "unknown error"}`, "muted");
      return speak("I couldn't open the design shop. The details are in the log.");
    }
    if (res.project && res.project.name) {
      log(`New design project: ${res.project.name} (${res.project.id})`, "muted");
      if (res.run && res.run.runId) {
        log(`Design run started: ${res.run.runId}`, "muted");
        return speak(`I've created a fresh project and started designing ${res.brief}. It'll take a few minutes — you can watch it come together in your browser.`);
      }
      if (res.runError) {
        log(`[design] run not started: ${res.runError}`, "muted");
        return speak("I created the project and opened the shop, but couldn't start the design run automatically.");
      }
      const verb = res.launched ? "started your design shop and created" : "created";
      return speak(`I've ${verb} a fresh design project for you. It's opening in your browser now.`);
    }
    if (res.projectError) {
      log(`[design] project not created: ${res.projectError}`, "muted");
      return speak("Your design shop is open, but I couldn't start a new project automatically.");
    }
    return speak("Your design shop is open and ready.");
  } catch (e) {
    log(`[design] threw: ${e && e.message ? e.message : e}`, "muted");
    return speak("Something went wrong opening the design shop.");
  }
}

/** Run a data-grounded finance report briefing. In the desktop app this goes
 *  through the Kiro CLI (IPC) to the finance agent; in browser mode it uses the
 *  Flask backend's /report endpoint. (Growth reporting is excluded from this
 *  build — the Chief Growth Officer role is not offered.) */
async function runReport(kind, label) {
  setStatus("WORKING");
  beginHandoff(kind, "FINANCE");

  // Desktop app: first read the REAL, data-grounded summary written to the
  // bridge output file. If it's fresh, speak it instantly. Otherwise request a
  // fresh one through the Quick bridge.
  if (IN_ELECTRON) {
    const wantTask = "finance";
    try {
      const out = await window.coco.readOutput(wantTask);
      // Fresh matching output → speak it instantly. Combine the intro + summary
      // into ONE utterance so a back-to-back speak() doesn't cancel itself
      // (cancel-then-speak races in Electron and can leave nothing spoken).
      if (out && !out.error && out.summary) {
        const intro = pick([`Here's your ${label} briefing.`, `Right then — your ${label} numbers.`]);
        log(out.summary, "a");
        if (out.metrics) log(`metrics: ${JSON.stringify(out.metrics)}`, "muted");
        return speakLong(`${intro} ${out.summary}`);
      }
      // Stale output → tell the user and request fresh.
      if (out && out.error === "stale") {
        log(`[report] ${wantTask} cached data is ${out.staleAge || "?"}min old; requesting fresh.`, "muted");
      } else if (out && out.error) {
        log(`[report] ${out.error}`, "muted");
      }
    } catch (e) {
      log(`[report] could not read output: ${e && e.message ? e.message : e}`, "muted");
    }

    // No matching output on file → request it fresh through the Quick bridge
    // (the real data source). This writes a request and waits for Quick.
    return askQuickBridge("finance-summary", "finance briefing");
  }

  // Browser mode: use the local Flask backend's report endpoint.
  speak(pick([`Pulling the ${label} report now.`, `One moment — fetching the ${label} numbers.`]));
  try {
    const res = await fetch(`${COCO_BACKEND}/report/${kind}`, { method: "POST" });
    const data = await res.json();
    if (!res.ok || data.error) {
      log(data.error || `Backend error (${res.status}).`, "muted");
      return speak(`I couldn't pull the ${label} report. Do check that my backend and the API environment are set up.`);
    }
    log(data.reply, "a");
    return speakLong(data.reply);
  } catch (e) {
    log(`Backend unreachable: ${e}`, "muted");
    return speak("My backend isn't responding. Please start it and try again.");
  }
}
let currentAgent = "";   // "" = backend default

// When Coco asks a follow-up ("What would you like built?"), we remember which
// handler should receive the NEXT utterance so it doesn't fall through to the
// generic command router. Set to a function (text) => Promise, or null.
let pendingFollowup = null;

/** Parse an optional "ask <agent> ..." / "use <agent> ..." target from a
 *  command, returning { agent, text } with the agent stripped from the text. */
function extractAgent(cmd) {
  const m = cmd.match(/^(?:ask|use|tell|switch to)\s+(the\s+)?([a-z-]+)\s*(agent)?[\s,:-]*(.*)$/i);
  if (m) {
    const key = m[2].toLowerCase();
    if (AGENT_ALIASES[key]) {
      return { agent: AGENT_ALIASES[key], text: (m[4] || "").trim() };
    }
  }
  return { agent: currentAgent, text: cmd };
}

async function askKiro(command) {
  const { agent, text } = extractAgent(command);
  const prompt = text || command;
  setStatus("WORKING");
  speak(pick(["On it.", "Right away.", "Let me see to that.", "One moment."]));
  try {
    let data;
    if (IN_ELECTRON) {
      data = await window.coco.kiro(prompt, agent);
    } else {
      const res = await fetch(`${COCO_BACKEND}/kiro`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: prompt, agent }),
      });
      if (!res.ok) {
        log(`Backend error (${res.status}).`, "muted");
        return speak("I couldn't reach Kiro. Do check that my backend is running.");
      }
      data = await res.json();
    }
    if (!data || data.error) {
      log((data && data.error) || "No response from Kiro.", "muted");
      return speak("I couldn't reach Kiro. Do check that my backend is running.");
    }
    log(data.reply, "a");
    // Speak a trimmed version (long agent replies get shortened for the voice;
    // the full text stays in the log).
    return speakLong(data.reply);
  } catch (e) {
    log(`Backend unreachable: ${e}`, "muted");
    return speak("My Kiro backend isn't responding. Please start it and try again.");
  }
}

/** Open the calendar: read the latest events from the Quick calendar-check
 *  cache and speak them while the bottom-left calendar ring lights up. */
async function runCalendar() {
  setStatus("WORKING");
  document.body.classList.add("calendar-active");
  if (!IN_ELECTRON) {
    document.body.classList.remove("calendar-active");
    return speak("The calendar only works in the desktop app.");
  }
  try {
    const cal = await window.coco.readOutput("calendar-check");
    if (cal && !cal.error && cal.summary) {
      log(cal.summary, "a");
      if (cal.metrics) log(`events: ${JSON.stringify(cal.metrics)}`, "muted");
      return speakLong(`Here's your calendar. ${cal.summary}`);
    }
    if (cal && cal.error === "stale") {
      log(`[calendar] cache is ${cal.staleAge || "?"}min old; requesting fresh.`, "muted");
    }
  } catch (e) {
    log(`[calendar] could not read cache: ${e && e.message ? e.message : e}`, "muted");
  }
  // Nothing cached/fresh — request via the Quick bridge.
  return askQuickBridge("calendar-check", "calendar");
}

/** Chief Security Officer: runs an AWS security posture review via the Kiro CLI
 *  (reads infra/config, uses aws-docs MCP). Advisory findings + remediations. */
async function runSecurity(command) {
  setStatus("WORKING");
  beginHandoff("security", "SECURITY");
  speak(pick(["Running your security review now.", "One moment — reviewing your AWS security posture."]));

  if (!IN_ELECTRON) {
    return speak("The security officer only runs in the desktop app.");
  }

  const extra = (command || "").replace(/\b(cso|chief security officer|security officer|security)\b/gi, "").trim();
  const prompt = extra && extra.length > 3
    ? `As my Chief Security Officer, focus on: ${extra}. Review the relevant AWS infra/config and give prioritized findings with severities and concrete remediations.`
    : "As my Chief Security Officer, review the app's AWS security posture — IAM least-privilege, network/WAF exposure, data encryption, secrets handling, and logging. Read the relevant infra/config to ground it. Give the top 2-3 prioritized findings with severity and a specific fix for each, and the single highest-priority action first.";

  try {
    const data = await window.coco.kiro(prompt, "chief-security-officer");
    if (!data || data.error) {
      log((data && data.error) || "No response from Kiro.", "muted");
      return speak("I couldn't reach the security officer.");
    }
    log(data.reply, "a");
    return speakLong(data.reply);
  } catch (e) {
    log(`Security agent error: ${e}`, "muted");
    return speak("I ran into a problem running the security review.");
  }
}

/** PM Agent: reads the product backlog + real usage data, then either reports
 *  on the backlog with prioritized recommendations, or (when the command asks)
 *  adds/updates a backlog item. Grounded, spoken-friendly. */
async function runPmAnalysis(command) {
  setStatus("WORKING");
  beginHandoff("pm", "PM");

  if (!IN_ELECTRON) {
    return speak("The PM agent only runs in the desktop app.");
  }

  const cmd = (command || "").toLowerCase();

  // Detect an "add to backlog" intent and capture the item text.
  const addM = cmd.match(/\b(?:add|log|put|create|note)\b.*?\b(?:to (?:the )?backlog|backlog item|as a (?:task|story|ticket))\b[\s:,-]*(.*)$/i)
            || cmd.match(/\bbacklog\b[\s:,-]*(add|new)\b[\s:,-]*(.*)$/i);
  if (addM) {
    const item = (addM[2] || addM[1] || "").trim();
    if (item && item.length > 2) {
      try {
        const res = await window.coco.backlogAdd(item);
        if (res && res.ok) {
          log(`Backlog: added "${item}" (#${res.count})`, "muted");
          return speak(`Added to the backlog: ${item}. You now have ${res.count} items.`);
        }
        return speak("I couldn't add that to the backlog.");
      } catch (e) {
        log(`[pm] backlog add error: ${e && e.message ? e.message : e}`, "muted");
        return speak("I ran into a problem updating the backlog.");
      }
    }
  }

  // Otherwise: analyze. Gather the backlog + real usage data to ground the PM.
  let ctx = "";
  try {
    const bl = await window.coco.backlogList();
    if (bl && Array.isArray(bl.items) && bl.items.length) {
      ctx += "CURRENT PRODUCT BACKLOG:\n" + bl.items.map((it, i) => `${i + 1}. ${it.text}${it.done ? " (done)" : ""}`).join("\n") + "\n";
    } else {
      ctx += "CURRENT PRODUCT BACKLOG: (empty)\n";
    }
  } catch {}
  try {
    // Ground the PM in daily usage data (daily-summary), since the dedicated
    // growth/CGO briefing is excluded from this build.
    const usage = await window.coco.readOutput("daily-summary");
    if (usage && usage.summary) {
      ctx += `\nUSAGE / ACTIVITY DATA:\n${usage.summary}\n`;
      if (usage.metrics) ctx += `USAGE METRICS: ${JSON.stringify(usage.metrics)}\n`;
    }
  } catch {}

  const wantsPrioritize = /\bprioriti|rank|order|what.*next|top of|groom|triage\b/.test(cmd);
  const prompt = wantsPrioritize
    ? `As my product manager, review the current backlog against the usage data and PRIORITIZE it. Tell me the single highest-priority item to do next and why, then the next two, ranked by impact vs. effort. Data:\n\n${ctx}`
    : `As my product manager, give me a product briefing: read the backlog and usage data, call out the top opportunities/risks, and recommend the top next steps to add or prioritize on the backlog. Data:\n\n${ctx}`;

  try {
    const data = await window.coco.kiro(prompt, "pm-agent");
    if (!data || data.error) {
      log((data && data.error) || "No response from Kiro.", "muted");
      return speak("I couldn't reach the PM agent.");
    }
    log(data.reply, "a");
    return speakLong(data.reply);
  } catch (e) {
    log(`PM agent error: ${e}`, "muted");
    return speak("I ran into a problem running the PM analysis.");
  }
}

/** Speak long text without dumping paragraphs — read the first meaningful
 *  chunk aloud and note that the full reply is in the log. */
function speakLong(text) {
  const clean = text.replace(/```[\s\S]*?```/g, " (code block omitted) ")
                    .replace(/\s+/g, " ").trim();
  const MAX = 600;
  if (clean.length <= MAX) return speak(clean);
  const cut = clean.slice(0, MAX);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  const spoken = (end > 200 ? cut.slice(0, end + 1) : cut) + " The full reply is in the log.";
  return speak(spoken);
}

// =============================================================================
// COMMAND ROUTER — map phrases to actions (extend freely)
// =============================================================================
function handleTranscript(text) {
  const heardWake = WAKE_WORDS.some((w) => text.includes(w));
  const command = stripWake(text);
  log(text, "u");

  // Once the mic is on (user tapped to listen), we treat the session as "awake"
  // so plain commands work without repeating the wake word every time. The wake
  // word is still honored (and required only if you build always-on listening).
  if (!command && heardWake) {
    setStatus("LISTENING");
    speak(`${greetingForTime()}, ${OWNER_NAME}. What should we tackle?`);
    return;
  }
  if (!command) return;

  route(command);
}

function stripWake(text) {
  let t = text;
  for (const w of WAKE_WORDS) t = t.replace(w, "");
  return t.replace(/^[\s,.:;-]+/, "").trim();
}

function route(rawCmd) {
  setStatus("PROCESSING");

  const done = () => { setStatus("AWAITING\nCOMMAND"); endHandoff(); };

  // "Call my …" (and "call the …", "get me my …", "bring up my …") is a command
  // trigger — normalize it away so the intent underneath matches cleanly.
  const cmd = rawCmd
    .replace(/^\s*(please\s+)?(can you\s+|could you\s+|would you\s+)?(call|get|bring up|open|launch|fetch|pull up|ring)\s+(me\s+)?(my|the|our)\s+/i, "")
    .trim() || rawCmd;

  // --- PENDING FOLLOW-UP ----------------------------------------------------
  // If Coco just asked a question (e.g. "What would you like built?"), route
  // this utterance straight to the waiting handler instead of the generic
  // router. "never mind"/"cancel"/"stop" clears it without dispatching.
  if (pendingFollowup) {
    const followup = pendingFollowup;
    pendingFollowup = null;
    if (/^\s*(never ?mind|cancel|stop|forget it|nothing)\b/i.test(cmd)) {
      return speak("No problem.").then(done);
    }
    return followup(cmd).then(done);
  }

  // --- HIGH PRIORITY: design shop, Quick bridge tasks, named agents ---------
  // These win over greeting/status chit-chat.

  // UX Design Shop → launch the Open Design daemon + web UI (a design project).
  // (Local action, not a Quick task — checked first.)
  if (/\b(ux|u x|design shop|design studio|design team|open design)\b/.test(cmd)) {
    return launchDesignShop(extractDesignBrief(cmd)).then(done);
  }

  // PM Agent → product management: reads/updates the backlog + usage data,
  // prioritizes, and recommends. "call my PM", "product manager", "backlog",
  // "add X to the backlog", "what should we build next", "prioritize the backlog".
  if (/\b(pm|product manager|product management|backlog|roadmap)\b/.test(cmd)) {
    return runPmAnalysis(cmd).then(done);
  }

  // Chief Security Officer → AWS security posture review.
  // "call my CSO", "security officer", "security review", "how's my security".
  if (/\b(cso|security officer|chief security|security review|security posture|how.*secur)\b/.test(cmd) || /\bsecurity\b/.test(cmd)) {
    return runSecurity(cmd).then(done);
  }

  // Calendar → read latest events from Quick's calendar cache, ring lights up.
  // "open the calendar", "calendar", "my schedule", "any meetings today".
  if (/\b(calendar|schedule|my agenda|meetings today|events today|what.*on.*(today|schedule|calendar))\b/.test(cmd)) {
    return runCalendar().then(done);
  }

  // AI Developer → the Kiro CLI (this is the ONLY way Kiro is invoked by voice).
  // "call my AI developer, <request>" or just "AI developer" to engage it.
  const devM = cmd.match(/\b(ai developer|a\.?i\.? developer|my developer|kiro)\b[\s,:-]*(.*)$/i);
  if (devM) {
    const rest = (devM[2] || "").trim();
    currentAgent = "";   // Kiro default agent
    beginDevHandoff();
    if (!rest) {
      // Wait for the user's next utterance and send it to the AI Developer.
      pendingFollowup = (text) => { beginDevHandoff(); return askKiro(text); };
      return speak("Your AI developer is ready. What would you like built?").then(done);
    }
    return askKiro(rest).then(done);
  }

  // Quick Voice Bridge: match the transcript against the registered tasks
  // (longest trigger phrase wins). Finance keeps its fast local output-file
  // path; the others go through the Quick request/response bridge.
  const qt = matchQuickTask(cmd);
  if (qt) {
    if (qt.task === "finance-summary") return runReport("finance", "finance").then(done);
    return askQuickBridge(qt.task, qt.label).then(done);
  }

  // Named C-suite / Kiro agent dispatch (e.g. "call my marketing", "ask crew ...").
  for (const alias of Object.keys(AGENT_ALIASES)) {
    const re = new RegExp(`\\b${alias.replace(/\s+/g, "\\s+")}\\b[\\s,:-]*(.*)$`, "i");
    const m = cmd.match(re);
    if (m) {
      const rest = (m[1] || "").trim();
      currentAgent = AGENT_ALIASES[alias];
      // Map the agent to a right-panel key for the handoff highlight.
      // (Growth and Marketing & Sales are excluded from this build.)
      const agentName = AGENT_ALIASES[alias];
      const key = /ux-design/.test(agentName) ? "ux"
        : /finance/.test(agentName) ? "finance" : null;
      if (key) beginHandoff(key, alias.toUpperCase());
      if (!rest) return speak(`${alias} agent ready. What would you like?`).then(done);
      return askKiro(rest).then(done);
    }
  }

  if (/\b(time|what.*time)\b/.test(cmd)) {
    const now = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    return speak(pick([
      `It's ${now}, my dear.`,
      `The time is ${now}. A lovely hour, isn't it?`,
    ])).then(done);
  }
  if (/\b(date|what.*day|today)\b/.test(cmd)) {
    const now = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
    return speak(`Today is ${now}. A splendid day for it.`).then(done);
  }
  if (/\b(hello|hi|hey|good (morning|evening|afternoon))\b/.test(cmd)) {
    return speak(pick([
      "Hello, my dear. How lovely to see you.",
      "Good day to you. What a pleasure.",
      "Well hello there. Shall we begin?",
    ])).then(done);
  }
  if (/\b(status|systems|how are things|all good)\b/.test(cmd)) {
    return speak(pick([
      "Everything is quite in order, I'm pleased to say.",
      "All systems are running beautifully. Practically perfect.",
      "Splendid news — everything is shipshape and humming along.",
    ])).then(done);
  }
  if (/\b(who are you|your name|what are you)\b/.test(cmd)) {
    return speak("I'm Jarvis, your Chief of Staff — here to keep everything tidy and running just so.").then(done);
  }
  if (/\b(joke|funny)\b/.test(cmd)) {
    return speak(pick([
      "Why did the little byte pop off to bed? It was feeling a touch overtired. Ha!",
      "In every task there is an element of fun. Find the fun, and snap — the job's a game.",
    ])).then(done);
  }
  if (/\b(thank|thanks)\b/.test(cmd)) {
    return speak(pick([
      "You're most welcome, my dear.",
      "Think nothing of it. A pleasure, always.",
    ])).then(done);
  }
  if (/\b(stop|silence|quiet|cancel)\b/.test(cmd)) {
    try { speechSynthesis.cancel(); } catch {}
    try { if (window.coco && window.coco.sayStop) window.coco.sayStop(); } catch {}
    return done();
  }

  // (Reports + named-agent dispatch are handled at the top of route().)

  // Switch the active Kiro agent by voice, e.g. "switch to planner".
  const switchM = cmd.match(/^(?:switch to|use)\s+(the\s+)?([a-z-]+)\s*agent$/i);
  if (switchM && AGENT_ALIASES[switchM[2].toLowerCase()]) {
    currentAgent = AGENT_ALIASES[switchM[2].toLowerCase()];
    return speak(`Very good — I'll use the ${switchM[2]} agent.`).then(done);
  }
  // List agents.
  if (/\b(list|what|which) (agents|agent)\b/.test(cmd)) {
    return speak("The available agents include default, help, planner, crew, research, and knowledge.").then(done);
  }

  // Unrecognized command — do NOT auto-send to Kiro. Coco only engages the AI
  // developer on the explicit "AI developer" trigger. Give a gentle nudge.
  return speak(pick([
    "I'm not quite sure what you'd like. Try a report, your schedule, or say \u201ccall my AI developer\u201d.",
    "I didn't catch a command there. You can ask for a briefing, your calendar, or your AI developer.",
  ])).then(done);
}

// =============================================================================
// UI STATE
// =============================================================================
function setStatus(text) { statusText.innerHTML = text.replace(/\n/g, "<br />"); }

function setListening(on) {
  listening = on;
  body.classList.toggle("listening", on);
  if (on) {
    listeningText.textContent = "Listening\u2026";
    setStatus("LISTENING");
    if (useNativeSR) startNativeRecognition();
    else if (recog) { try { recog.start(); } catch {} }
    startMicAnalyser();
  } else {
    listeningText.innerHTML = 'Tap the mic or say &ldquo;Hey Jarvis&rdquo;';
    setStatus("AWAITING\nCOMMAND");
    clearSilenceTimer();
    if (useNativeSR) stopNativeRecognition();
    else if (recog) { try { recog.stop(); } catch {} }
  }
}

micBtn.addEventListener("click", () => {
  // First tap also unlocks audio (browsers require a user gesture). Also clears
  // any stuck TTS state left behind by a permission change / interruption.
  unlockAudio();   // prime TTS on this gesture so auto-submitted speech plays
  try { if (!speaking && speechSynthesis.speaking) speechSynthesis.cancel(); } catch {}
  if (!recogSupported) {
    log("Speech recognition isn't supported in this browser. Try Chrome/Edge.", "muted");
  }
  setListening(!listening);
});

// Immediately cut off whatever Coco is saying (native `say` + Web Speech).
function stopSpeaking() {
  try { if (window.coco && window.coco.sayStop) window.coco.sayStop(); } catch {}
  try { speechSynthesis.cancel(); } catch {}
  speaking = false;
  body.classList.remove("speaking");
  targetGlow = 0.22;
  setStatus("AWAITING\nCOMMAND");
  endHandoff();
}
document.getElementById("stopBtn").addEventListener("click", stopSpeaking);

// Text input — type a question/command to Coco (routes the same as speech).
document.getElementById("askForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = document.getElementById("askInput");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  unlockAudio();   // unlock/prime audio on this user gesture
  handleTranscript(text.toLowerCase());
});

// Safety net: prime audio on the very first interaction anywhere in the window,
// so TTS is unlocked no matter how the user first engages.
["pointerdown", "keydown"].forEach((ev) =>
  window.addEventListener(ev, () => unlockAudio(), { once: true, capture: true })
);

// =============================================================================
// RENDER LOOP — waveform + core glow
// =============================================================================
function render() {
  requestAnimationFrame(render);

  // Smooth the core glow toward its target.
  glow += (targetGlow - glow) * 0.15;
  core.style.setProperty("--glow", glow.toFixed(3));

  // Waveform.
  const w = canvas.width, h = canvas.height, mid = h / 2;
  ctx.clearRect(0, 0, w, h);
  ctx.lineWidth = 2 * devicePixelRatio;
  ctx.strokeStyle = "rgba(53,214,255,0.9)";
  ctx.shadowColor = "rgba(53,214,255,0.8)";
  ctx.shadowBlur = 12 * devicePixelRatio;
  ctx.beginPath();

  const t = performance.now() / 1000;
  const N = 128;
  for (let i = 0; i <= N; i++) {
    const x = (i / N) * w;
    let amp;
    if (listening && micAnalyser) {
      // Live mic amplitude.
      micAnalyser.getByteTimeDomainData(micData);
      const idx = Math.floor((i / N) * micData.length);
      amp = ((micData[idx] - 128) / 128) * (h * 0.42);
    } else if (speaking) {
      // Voice-driven synthetic wave (scaled by glow envelope).
      const env = glow;
      amp = Math.sin(i * 0.35 + t * 10) * (h * 0.34) * env
          + Math.sin(i * 0.11 + t * 5) * (h * 0.12) * env;
    } else {
      // Idle: gentle flat shimmer.
      amp = Math.sin(i * 0.18 + t * 1.5) * (h * 0.04);
    }
    const y = mid + amp;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.shadowBlur = 0;
}
render();

// =============================================================================
// TELEMETRY — uptime clock + drifting readouts (cosmetic)
// =============================================================================
// Live clock in New York time (America/New_York → EST/EDT automatically),
// plus today's weekday and date. Independent of the machine's timezone.
const NY_TZ = "America/New_York";
const clockDayEl = document.getElementById("clockDay");
const clockDateEl = document.getElementById("clockDate");
const nyTimeFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: NY_TZ, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});
const nyDayFmt = new Intl.DateTimeFormat("en-US", { timeZone: NY_TZ, weekday: "long" });
const nyDateFmt = new Intl.DateTimeFormat("en-US", { timeZone: NY_TZ, month: "long", day: "numeric", year: "numeric" });

function tickClock() {
  const now = new Date();
  if (teleUptime) teleUptime.textContent = nyTimeFmt.format(now);
  if (clockDayEl) clockDayEl.textContent = nyDayFmt.format(now).toUpperCase();
  if (clockDateEl) clockDateEl.textContent = nyDateFmt.format(now);
  if (teleLoad) teleLoad.textContent = String(10 + Math.floor(Math.random() * 12));
  if (teleTemp) teleTemp.textContent = (21.5 + Math.random() * 2).toFixed(1);
}
tickClock();                 // render immediately so day/date/time show at once
setInterval(tickClock, 1000);

// Greeting once voices are ready (after a user gesture unlocks audio, the
// browser will actually play it; until then it's logged).
log("Jarvis, your Chief of Staff, is online. Ask me anything, or say \u201ccall my AI developer\u2026\u201d to engage Kiro.", "muted");
