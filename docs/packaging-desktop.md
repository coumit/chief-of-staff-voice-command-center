# Packaging — Mac, Windows & Linux Desktop

Chief of Staff (Jarvis) is an **Electron** app, so it can be packaged for macOS,
Windows, and Linux from the same codebase using
[electron-builder](https://www.electron.build/). Packaging is already configured
for macOS in `package.json`; this guide covers shipping a **Mac app** and adding
**Windows / Linux desktop** targets.

> **Important platform note.** The voice layer has two tiers:
>
> - **macOS (native):** on-device `SFSpeechRecognizer` (the bundled
>   `native/coco-speech` Swift helper) for speech-to-text, and the `say` /
>   `afplay` commands for text-to-speech. This is the premium path.
> - **Windows / Linux (fallback):** `electron-main.js` guards every native call
>   with `process.platform !== "darwin"` and returns a clear error, and
>   `app.js` automatically falls back to the **Web Speech API**
>   (`speechSynthesis` + `SpeechRecognition`). The HUD, typing box, Quick
>   file-bridge, Kiro agents, and Open Design shop all work cross-platform; only
>   the *native* speech quality/reliability differs.
>
> The rest of this doc explains how to build each target and what to do about
> that voice difference.

---

## Common prerequisites

- **Node.js 18+** and npm.
- The repo installed: `npm install`.
- Icons in `build/` (`icon.icns` for macOS; add `icon.ico` for Windows and a
  PNG for Linux — see each section).

```bash
npm install
```

electron-builder places artifacts in `dist/`.

---

## 1. macOS app (`.app` + `.dmg`)

This is the fully-featured target and is already configured (`build.mac` in
`package.json`, arm64).

### Extra macOS prerequisites

- **Xcode command line tools** — needed once to compile the Swift speech helper:

  ```bash
  xcode-select --install
  swiftc -O -o native/coco-speech native/coco-speech.swift
  ```

- Premium `say` voice (optional): System Settings → Accessibility → Spoken
  Content → System Voice → manage voices → download e.g. **Ava (Premium)**.

### Build

```bash
npm run dist      # builds dist/CoS-<version>-arm64.dmg + the .app
# or, unpacked app only (faster, no dmg):
npm run pack      # dist/mac-arm64/CoS.app
```

The compiled `native/coco-speech` is bundled via `build.extraResources` and the
app requests Microphone + Speech Recognition permissions via the Info.plist
strings already declared in `package.json`.

### Signing & notarization (for distribution)

Unsigned builds run locally but Gatekeeper blocks them for other users. To
distribute:

1. Set `build.mac.identity` to your **Developer ID Application** certificate
   (currently `null` for local/unsigned builds).
2. Add notarization credentials (Apple ID + app-specific password or an API
   key) — the common approach is `@electron/notarize` via an
   `afterSign` hook, or electron-builder's `notarize` option.
3. Rebuild with `npm run dist`.

For an internal Intel + Apple-Silicon build, add `x64` to
`build.mac.target[].arch` (or use `"universal"`).

---

## 2. Windows app (`.exe` installer / portable)

### Icon

Add `build/icon.ico` (256×256 recommended). electron-builder auto-detects it.

### Add the Windows target to `package.json`

Add a `win` block alongside `mac` under `build`:

```json
"win": {
  "icon": "build/icon.ico",
  "target": [
    { "target": "nsis", "arch": ["x64"] },
    { "target": "portable", "arch": ["x64"] }
  ]
},
"nsis": {
  "oneClick": false,
  "perMachine": false,
  "allowToChangeInstallationDirectory": true
}
```

### Build

Build **on Windows** (native Windows targets are most reliable built on
Windows; a CI runner works well):

```bash
npm install
npm run dist      # dist/CoS Setup <version>.exe  (+ portable .exe)
```

### Voice on Windows

The native Swift helper and `say`/`afplay` do **not** exist on Windows —
`electron-main.js` already returns a clear error for those IPC calls, and
`app.js` falls back to the **Web Speech API**. Notes:

- **TTS** (`speechSynthesis`) works out of the box using installed Windows
  voices; `pickVoice()` in `app.js` selects a reasonable English voice.
- **STT** (`SpeechRecognition`) in Electron's Chromium is unreliable (it needs
  Google's cloud backend). Practically, on Windows use the **typing box** for
  commands, or wire a Windows STT engine. To keep voice-in, add a small helper
  analogous to `native/coco-speech` (e.g. using Windows Speech APIs) and branch
  on `process.platform === "win32"` in the `speech-start` IPC handler.

### Optional: exclude the Swift source from Windows builds

It's harmless to ship, but you can trim it via `build.files` negation
(`"!native/coco-speech.swift"`) in a Windows-only config if you prefer.

---

## 3. Linux app (`AppImage` / `deb`)

### Icon

Add a PNG (e.g. `build/icon.png`, 512×512).

### Add the Linux target to `package.json`

```json
"linux": {
  "icon": "build/icon.png",
  "category": "Utility",
  "target": [
    { "target": "AppImage", "arch": ["x64"] },
    { "target": "deb", "arch": ["x64"] }
  ]
}
```

### Build

Build **on Linux** (or in a Linux container/CI):

```bash
npm install
npm run dist      # dist/CoS-<version>.AppImage  (+ .deb)
```

`AppImage` is the most portable (no install needed: `chmod +x` and run). `deb`
targets Debian/Ubuntu.

### Voice on Linux

Same as Windows — native macOS speech is unavailable, so it uses the Web Speech
fallback. For reliable TTS install a speech engine (e.g. `espeak`/`speech-dispatcher`);
for STT, prefer the typing box or integrate a Linux STT engine behind a new
`process.platform === "linux"` branch in the `speech-start` handler.

---

## 4. Cross-building & CI (recommended)

Building each OS on its own runner avoids toolchain pain (especially macOS
signing and Windows NSIS). A minimal GitHub Actions matrix:

```yaml
name: build
on: [workflow_dispatch]
jobs:
  dist:
    strategy:
      matrix:
        os: [macos-latest, windows-latest, ubuntu-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      # macOS only: compile the native speech helper
      - if: runner.os == 'macOS'
        run: swiftc -O -o native/coco-speech native/coco-speech.swift
      - run: npm run dist
      - uses: actions/upload-artifact@v4
        with:
          name: cos-${{ matrix.os }}
          path: dist/**
```

Add signing secrets (Apple cert/notarization, Windows code-signing cert) as
encrypted repository secrets and reference them in the electron-builder config.

---

## 4b. Bundling Open Design (the UX Design Shop) in the installer

Open Design ships as a git submodule at `third_party/open-design` (see the
README's "Open Design (bundled)" section). Two decisions for packaging:

1. **Build it before packaging.** Run `./scripts/setup-open-design.sh` (needs
   **Node 24** + pnpm) on the build machine so `third_party/open-design` has its
   `node_modules` and `apps/daemon/dist` before electron-builder runs.

2. **Include it as an unpacked resource.** It's large and must stay on the real
   filesystem (the `od` CLI spawns a daemon and reads files), so ship it via
   `extraResources`, **not** inside the asar. Add to `build` in `package.json`:

   ```json
   "extraResources": [
     { "from": "native/coco-speech", "to": "native/coco-speech" },
     { "from": "third_party/open-design", "to": "third_party/open-design" }
   ]
   ```

   `electron-main.js` already probes `process.resourcesPath/third_party/open-design`
   (and the `app.asar.unpacked` path) to find the bundled `od` at runtime.

> **Trade-off:** bundling Open Design makes a large installer. If you'd rather
> keep the installer small, omit it from `extraResources` and instead have
> customers run `git submodule update --init --recursive` +
> `./scripts/setup-open-design.sh` next to the app, then point `OD_BIN` at it.
> Open Design also needs **Node 24** available at runtime to launch its daemon.

---

## 5. Configuration that applies to every OS

All of these are read from the environment (see `.env.example`) regardless of
platform:

| Var | Purpose |
|-----|---------|
| `COS_BRIDGE_ROOT` | Amazon Quick file-bridge folder (see `quick-setup.md`) |
| `COS_SAY_VOICE` | macOS `say` voice (macOS only) |
| `KIRO_CLI` / `KIRO_CWD` | Kiro agent CLI + working dir (CFO, PM, CSO, AI Developer) |
| `OD_BIN` / `OD_DAEMON_URL` | Override the bundled Open Design `od` CLI + daemon (UX Design Shop; auto-resolved from `third_party/open-design`) |

The **Chief Growth Officer** and **Marketing & Sales** roles are excluded from
this build on every platform (see the README and `app.js`).

### Path note for Windows/Linux

`COS_BRIDGE_ROOT` defaults to `~/Documents/CoS-Bridge` and works cross-platform
via Node's `os.homedir()`. The Kiro CLI PATH shim in `electron-main.js` currently
prepends macOS-style paths (`/opt/homebrew/bin`, etc.); on Windows/Linux set
`KIRO_CLI` to the absolute binary path so it resolves regardless of PATH.

---

## Quick reference

| Target | Command | Output | Build on |
|--------|---------|--------|----------|
| macOS `.dmg`/`.app` | `npm run dist` | `dist/*.dmg`, `.app` | macOS |
| Windows installer | `npm run dist` | `dist/*Setup*.exe` | Windows |
| Linux AppImage/deb | `npm run dist` | `dist/*.AppImage`, `.deb` | Linux |
| Unpacked (any) | `npm run pack` | `dist/<os>-*/` | that OS |
