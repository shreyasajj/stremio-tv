### 0.2.3
- Fix the video not showing while it plays (audio and the clock ran, but the stream picker stayed on screen). The UI's last frame was never cleared once the page went see-through; the web view now stays opaque until playback starts.
- Fix the video being drawn upside down.
- Diagnostics for TV boxes, no rebuild needed: `STREMIO_TV_MPV_LOG=v` for verbose mpv logs, `STREMIO_TV_MPV_OPTIONS="hwdec=no"` to override mpv options. The log now names the GPU and, for each video, the decoder in use.
- The end-to-end test now checks real picture content and real audio output (PulseAudio in the test container).

---

### 0.2.2
- Fix video playing hidden behind the stream-selection dialogs.
- Stop duplicate addon searches from being fired.
- Remote navigation and addon/stream list UI tweaks.

---

### 0.2.1
- First release built from `main`. The app itself is unchanged from 0.2.0.
- Releases are now published only for tags on `main`, after the end-to-end, UI and Flatpak checks pass.
- Dependabot now keeps npm and GitHub Actions dependencies up to date, auto-merging minor and patch updates once CI passes.

---

First release of the **native Stremio TV shell**. It uses the same remote-first UI as before, but plays video through embedded **libmpv** in a native Qt 6 Wayland window instead of Chromium's `<video>`.

### What's new compared with the Electron build
- **Codecs:** H.264, HEVC, AV1, VP9 and anything else FFmpeg handles. MKV, HLS and DASH play natively, with VAAPI hardware decoding where available.
- **Audio tracks:** real track switching in single-file MKVs. The audio menu shows codec and channels, and **what actually reaches the TV**, e.g. `EAC3 bitstream passthrough`.
- **Surround passthrough (experimental):** *Settings → Surround passthrough* sends AC3, E-AC3 (incl. Atmos), DTS, TrueHD and DTS-HD to the TV or soundbar untouched. Pick the HDMI ALSA device in *Settings → Audio output device* for the most reliable result. Not yet validated on real TV/soundbar hardware.
- **Subtitles:** embedded tracks and subtitle addons, rendered by mpv with full ASS styling.
- Same behaviour as before: always fullscreen, pauses on focus loss, keeps the screen awake only while playing.

### Install (Flatpak)
Download the bundle for your box (`x86_64` for most mini PCs, `aarch64` for ARM boards), then:

```bash
flatpak remote-add --user --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo
flatpak install --user ./stremio-tv-x86_64.flatpak
flatpak run io.github.shreyasajj.StremioTV
```

Flatpak pulls the KDE 6.10 runtime and the QtWebEngine base from Flathub on first install. The app then appears in the Plasma Bigscreen launcher.

Your addons and watch progress from the Electron build are **not** carried over: the native shell keeps its own storage. Re-add addons via *Add-ons → Import from Stremio account*.
