/* Secure bridge between the Coco renderer (UI) and the Electron main process.
 * Exposes exactly two capabilities — nothing else — under window.coco. */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("coco", {
  // Quick file-bridge: request a task, resolves when Quick writes a response.
  // Returns e.g. { status: "completed", summary: "..." } or { error }.
  quickTask: (task, params) => ipcRenderer.invoke("quick-task", task, params),

  // Kiro CLI agent call. Returns { reply, agent } or { error }.
  kiro: (message, agent) => ipcRenderer.invoke("kiro", message, agent),

  // Read the latest report output (growth/finance) from the bridge folder.
  readOutput: (task) => ipcRenderer.invoke("read-output", task),

  // Check whether the Amazon Quick bridge is set up (has Quick ever responded?).
  // Returns { ready, everResponded, bridgeRoot, requestsDir, ... }.
  bridgeStatus: () => ipcRenderer.invoke("bridge-status"),

  // Launch the Open Design daemon + web UI, create a project, and optionally
  // kick off a design run from a spoken brief ("call my design shop, start a
  // new design of a landing page").
  openDesign: (brief) => ipcRenderer.invoke("open-design", brief),

  // Native macOS TTS via `say` (reliable inside Electron, no gesture needed).
  say: (text, opts) => ipcRenderer.invoke("say", text, opts),
  sayStop: () => ipcRenderer.invoke("say-stop"),

  // Product backlog the PM agent reads/updates.
  backlogList: () => ipcRenderer.invoke("backlog-list"),
  backlogAdd: (text) => ipcRenderer.invoke("backlog-add", text),

  // Native macOS speech recognition (reliable inside Electron).
  speechStart: () => ipcRenderer.invoke("speech-start"),
  speechStop: () => ipcRenderer.invoke("speech-stop"),
  // Subscribe to streamed recognition events; returns an unsubscribe fn.
  onSpeech: (cb) => {
    const handler = (_evt, data) => cb(data);
    ipcRenderer.on("speech-event", handler);
    return () => ipcRenderer.removeListener("speech-event", handler);
  },

  // Flag the renderer can check to know it's running inside Electron.
  isElectron: true,
});
