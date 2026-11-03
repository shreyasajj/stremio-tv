### 0.5.0
- **More of Home at once.** Move down past the first row and the title card at the top fades away; the rows slide up so three of them fill the screen. Go back up to the first row and the title card returns. Posters on Home are a little smaller so the three rows fit.
- **New rows on Home.** New Releases (this year's movies and series from Cinemeta) now load instead of being skipped, and there are genre rows for Drama, Comedy, Action, Thriller and Sci-Fi.
- **Next episode dates.** Series show when their next episode airs (e.g. "Next episode S2 E3 · Friday, Nov 6") on the title page and the Home title card, and as a badge on Continue Watching.
- Fix focus leaving the nav rail: pressing Left on the rail could jump back into a row and scroll it, and Up/Down at its ends could drop into the content. The rail now holds focus until you press Right.

---

### 0.4.0
- **Home Assistant.** Optional, off by default: Stremio TV can show what is playing in Home Assistant (state, title and episode, position, duration, % watched, poster) and take play/pause, stop and skip ±30 s from it. It uses your own MQTT broker (e.g. the Mosquitto add-on) with MQTT Discovery, so a "Stremio TV" device appears in HA by itself, and HA shows it offline the moment the app quits or crashes.
- Set it up in **Settings → Home Assistant**: scan a QR code and type the broker login on your phone (the broker address is filled in when Home Assistant is found on your network), or enter it with the on-screen keyboard. Both end in a connection test. See the README for the entities and an example automation.

---

### 0.3.1
- Fix the screen occasionally reloading by itself while browsing. Focusing a poster or episode card could crash the web view on some systems, mostly with software rendering; card focus now changes instantly instead of animating.
- The native Qt + libmpv app is now the only build: the old Electron version and its install script are gone. Install from the Flatpak bundles on this page.

---

### 0.3.0
- **New look.** Redesigned for the 10-foot screen in the style of current streaming apps: near-black background, one accent colour, the Inter font (bundled), larger rounded cards, and a 5% TV-safe margin.
- **Home hero.** The focused title's backdrop, logo, year · runtime · rating · genres and synopsis fill the top of Home and follow focus along the rows. Play and Details are one press Up.
- **Poster rows.** Focused posters grow with a soft glow, and the title shows only on the focused card. Continue Watching uses wide backdrop cards with a progress bar and time left.
- **Slim nav rail.** Icons only; labels slide in when it has focus, and Left always lands on the current screen's item. All icons are now drawn as SVG, so nothing shows up as an empty box on TV boxes without emoji fonts (this fixes the Library icon).
- **Title page.** Full-screen backdrop, logo, fact chips and Play/Resume. Series get season chips and episode cards with thumbnail, runtime, air date and progress; Play starts S1 E1 when there's nothing to resume.
- **Search.** Top matches you can reach from the keyboard with →, and your recent searches while the query is empty.
- Search, Discover, Library, Settings, Add-ons, dialogs and the player controls restyled to match. Posters load lazily, and animations stay light for low-power boxes.

---

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
