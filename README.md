# Stremio TV

A **TV-first Stremio client** built for [KDE Plasma Bigscreen](https://invent.kde.org/plasma/plasma-bigscreen)
and other remote-controlled Linux boxes.

Stremio's official desktop apps (stremio-web / stremio-linux-shell) are designed for a
mouse. This app speaks the same **Stremio addon protocol** — so all your addons,
including **AIOStreams**, work exactly the same — but the whole interface is built for a
remote: arrow keys, OK, and Back are all you need.

## Features

- **Always fullscreen** — Electron kiosk window; if the compositor drops fullscreen it re-enters it.
- **100% arrow-key navigable** — a spatial-navigation engine drives every screen; nothing needs a pointer.
- **Sidebar** — press **Left** from anywhere to reach Search / Home / Discover / Library / Add-ons / Settings.
- **Full addon support** — install any addon by manifest URL (AIOStreams, Torrentio, Cinemeta, …) or
  **import your addon collection from your Stremio account**.
- **YouTube-TV-style player**:
  - **OK** → play/pause
  - **Left/Right** → seek −10s/+10s; repeated presses accelerate to 30s/60s/120s steps
  - **Up/Down** → show the control row (Pause · Subtitles · Audio · Speed · Next episode)
  - **Back** → hide controls / stop playback (progress is saved)
- **Continue Watching** — progress is stored locally; resume from Home, Library, or the title page.
- **Subtitles** — embedded tracks plus subtitle addons (e.g. OpenSubtitles), with adjustable size.
- **Type-anywhere search** — press any letter on any screen (with a physical/HDMI-CEC keyboard)
  and you land in Search with the keyboard open; results update live as you type, no need to
  press Done. Inside the on-screen keyboard, **Backspace deletes** (Esc closes) and you can
  **paste** with Ctrl+V or the keyboard's Paste key — handy for long AIOStreams URLs.
- **Series support** — season picker, episode list, auto "next episode" (binge groups auto-pick the same source).

## Requirements on the box

- Linux with Plasma Bigscreen (or any desktop — the app is just fullscreen)
- Node.js ≥ 18 and npm
- Network access to your addons

## Install on your streaming box

```bash
git clone <this repo> ~/stremio-tv
cd ~/stremio-tv
bash packaging/install.sh
```

That installs dependencies, creates a `stremio-tv` launcher in `~/.local/bin`, and adds a
**Stremio TV** entry to the app launcher (`X-KDE-BigScreen=true`, so Plasma Bigscreen
shows it as a tile). Start it from the launcher or run `stremio-tv`.

To run without installing: `npm install && npm start`.

## First start & AIOStreams

1. On first start the app installs the default **Cinemeta** (catalogs/metadata) and
   **OpenSubtitles** addons.
2. Open **Add-ons** in the sidebar → **Add addon by URL** → enter your AIOStreams manifest
   URL (the `https://…/manifest.json` link from your AIOStreams configuration page —
   `stremio://` links work too).
   Or use **Import from Stremio account** to pull everything you already have configured.
3. Pick anything from Home/Discover/Search → **Play** → choose an AIOStreams result.

Debrid/direct HTTP streams play natively. **Raw torrent streams** (`infoHash` results,
e.g. Torrentio without debrid) need Stremio's streaming server: run it somewhere
(`stremio-service` provides it on port 11470) and set its URL in **Settings → Streaming
server URL** (e.g. `http://127.0.0.1:11470`).

## Remote / key mapping

| Key                                   | Action                                    |
| ------------------------------------- | ----------------------------------------- |
| Arrow keys                            | Move focus / seek (in player)             |
| Enter / OK / Select                   | Activate / play-pause                     |
| Esc / Backspace / Back                | Go back / hide player controls / exit app |
| Play-Pause / Stop / FF / RW media keys| Player control from anywhere              |

Most TV remotes (HDMI-CEC via `cec-ctl`, Bluetooth remotes, air mice) present these as
regular keyboard keys, which is all the app listens for.

## Focus & power behavior

- **Losing focus pauses playback.** If you switch to another app (or the window is
  hidden), the video pauses immediately — no decoding, no stream downloading, no audio
  behind whatever is now on screen. It stays paused when you come back; press **OK** to
  resume from the paused overlay.
- **Background throttling** is enabled, so a hidden Stremio TV window costs almost no CPU.
- **The screen stays awake only while playing.** A power-save blocker is held during
  playback and released the moment you pause or stop, so the box can blank/sleep normally
  otherwise.

## Do I need the Stremio streaming server (backend)?

**Usually no.** In official Stremio, the UI and playback are separate pieces (the
streaming-server backend downloads/serves the stream, and on desktop an external player
process plays it) — which is why a crashed frontend there can leave audio playing.
Stremio TV has no such split: the video plays inside the app's own window, in the same
process tree. If the app closes or crashes, playback dies with it, and losing focus
pauses it (see above). There is no separate service to install, start, or leak resources.

The one thing the backend provides that this app doesn't is a **torrent engine**. Streams
that are direct HTTP links — everything AIOStreams/debrid returns — play natively. Only
if you want addons that return raw torrent `infoHash` results (e.g. Torrentio without
debrid) do you need Stremio's streaming server running somewhere, with its URL set in
**Settings → Streaming server URL**.

## Codec notes

Playback uses Chromium's media stack: H.264/AAC/VP9/AV1/Opus/Vorbis work out of the box,
HLS via hls.js. **HEVC** plays only where the box has hardware decoding Chromium can use
(VAAPI flags are enabled). With AIOStreams you can filter for H.264 sources if your box
lacks HEVC decode. Multi-audio-track switching is supported for HLS streams; single-file
MKV audio switching is limited by Chromium.

## Development & tests

```bash
npm run serve        # serve the UI at http://127.0.0.1:8099/ui/index.html
npm run mock-addon   # local offline test addon on http://127.0.0.1:7010
npm run test:addons  # live addon-protocol smoke test against Cinemeta (needs internet)
npm run test:ui      # headless end-to-end test: drives the UI with arrow keys (SHOTS=1 for screenshots)
```

Project layout: `main.js`/`preload.js` are the Electron shell; everything else lives in
`ui/` — `js/nav.js` (spatial navigation), `js/addons.js` (addon protocol client),
`js/player.js` (player + overlay), `js/screens/*` (screens), `js/stremio-api.js`
(account login/addon import).
