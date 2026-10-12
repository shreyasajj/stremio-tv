# Native Stremio TV: Wayland prototype

This is the **first runnable native playback shell**, not a completed replacement
for the Electron application. It uses **Qt 6 Quick + embedded libmpv** via
`QQuickFramebufferObject` and never launches an external player window.
It retains a fullscreen, arrow-key/OK/Back-controlled overlay. The Stremio
addon discovery, login, catalog and Continue Watching systems are **not yet ported**.

## KDE neon prerequisites

```bash
sudo apt update
sudo apt install build-essential cmake pkg-config qt6-base-dev qt6-declarative-dev \
  libmpv-dev libgl1-mesa-dev mpv alsa-utils
```

## Build / run

```bash
cmake -S native -B native/build -DCMAKE_BUILD_TYPE=Release
cmake --build native/build -j"$(nproc)"
QT_QPA_PLATFORM=wayland ./native/build/stremio-tv-native
```

To force a known working HDMI ALSA output:

```bash
mpv --audio-device=help
STREMIO_TV_AUDIO_DEVICE='alsa/hdmi:CARD=HDMI,DEV=0' \
  QT_QPA_PLATFORM=wayland ./native/build/stremio-tv-native
```

The device above is **an example only**. Select the actual HDMI output found
on your hardware. Paste a direct media URL in the field and press Play.

## Playback and Atmos constraints

- `audio-spdif=ac3,eac3,truehd` requests encoded passthrough via ALSA.
  It **does not ensure** Atmos reaches the soundbar; the audio device, EDID,
  Hisense eARC configuration, stream track and soundbar must support it.
- The application shows the decoded/identified audio codec name, not a
  verified Atmos/JOC flag or proof that passthrough is active.
- Try known E-AC3 Atmos test content before TrueHD Atmos.
- Encoded passthrough makes in-app digital volume controls inappropriate:
  adjust volume at the soundbar.
- This is a Qt Quick **OpenGL** renderer. Native Wayland compositors can run
  OpenGL clients; confirm your GPU/driver supports Qt Quick OpenGL.
- `QQuickFramebufferObject` is a functional but Qt 6 legacy OpenGL bridge.
  A QRhi-native rendering item would be a subsequent optimization.
- No raw torrent engine is bundled; use authorized direct HTTP media.

## Remaining migration work

Port Stremio addon API and browser/navigation model, episode selection,
subtitle addons, multi-track audio UI, watch progress storage, packaging,
automated tests and remote hardware testing. Retain Electron as a fallback
until those features and HDMI audio are validated.
