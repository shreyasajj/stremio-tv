# Native Stremio TV shell (Qt 6 + libmpv)

The remote-first web UI (`../ui`), hosted in a native
Qt 6 window (Wayland or X11) with **embedded libmpv** for playback:

```
QQuickWindow (fullscreen, OpenGL)
├── MpvVideo        libmpv frames rendered into the scene graph
└── WebEngineView   the UI, transparent while a video plays
       └─ QWebChannel: window.shell  (bridge.js ↔ ShellBridge, MpvController)
```

`ui/js/mpv-video.js` makes mpv look like an HTML `<video>` element, so
`player.js` drives it with the same code it uses for `<video>` in the
browser-based UI tests.

| File | Role |
| --- | --- |
| `mpvcontroller.*` | libmpv core: commands, options, observed properties → UI |
| `mpvitem.*` | `MpvVideo` QML item: OpenGL render of the mpv frames |
| `shellbridge.*` | `window.shell`: subtitle fetch, clipboard, quit, screensaver inhibit |
| `homeassistant.*` | `shell.homeAssistant`: MQTT link to Home Assistant (libmosquitto), discovery, last will, commands |
| `phonesetup.*` | the "Set up with phone" page on the LAN, its QR code and the mDNS lookup of Home Assistant |
| `third_party/qrcodegen` | Nayuki's QR Code generator (MIT) |
| `bridge.js` | injected into the page; builds `window.shell` over QWebChannel |
| `Main.qml` | window, video item, web view, persistent profile |

## Build & run from source (KDE neon / Debian / Ubuntu 24.10+)

```bash
sudo apt install build-essential cmake ninja-build pkg-config libmpv-dev libmosquitto-dev \
  qt6-base-dev qt6-declarative-dev qt6-webengine-dev qt6-webchannel-dev \
  qml6-module-qtquick qml6-module-qtquick-window qml6-module-qtwebengine \
  qml6-module-qtwebchannel qt6-wayland
cmake -S native -B native/build -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build native/build
./native/build/stremio-tv-native            # fullscreen
STREMIO_TV_WINDOWED=1 ./native/build/stremio-tv-native   # windowed, for development
```

Qt 6.5 or newer is required. A source build loads the UI straight from `../ui`, so
UI edits only need an app restart.

## Flatpak

```bash
flatpak-builder --user --install --force-clean --install-deps-from=flathub \
  build-dir native/packaging/flatpak/io.github.shreyasajj.StremioTV.yml
flatpak run io.github.shreyasajj.StremioTV
```

CI (`.github/workflows/native.yml`) builds x86_64 and aarch64 bundles on every
push. Pushing a `v*` tag publishes them as a GitHub Release.

## Tests

`test/native-test.js` launches the real binary, attaches over Chromium's remote
debugging protocol, and drives it with remote keys against the mock addon. It
checks playback through mpv's own properties: playing, pause, seek, the addon
subtitle loaded, resume, and that the page goes transparent. With `SHOTS=1` it saves
composited window grabs, video included.

```bash
# anywhere with Docker: headless Weston + software GL
docker build -t stremio-tv-native-dev native/dev
docker run --rm -v "$PWD":/src -w /src -e SHOTS=1 stremio-tv-native-dev sh native/dev/run-tests.sh
# or on the box itself, after building
NATIVE_BIN=native/build/stremio-tv-native npm run test:native
```

## Audio passthrough (Atmos/DTS) checklist

1. *Settings → Audio output device*: pick the HDMI ALSA device (`alsa/hdmi:CARD=…`).
   This opens the device directly, bypassing PipeWire.
2. *Settings → Surround passthrough*: pick the codecs your receiver accepts.
   TrueHD and DTS-HD need HDMI eARC.
3. Play a title with an E-AC3/Atmos track, open *Audio* in the player. The
   selected track should read `Output: EAC3 bitstream passthrough`. That line is
   mpv's real output format. The soundbar's display is the final word on Atmos.
4. In passthrough, set the volume on the TV or soundbar; the app can't scale a bitstream.

## Environment variables

| Variable | Effect |
| --- | --- |
| `STREMIO_TV_WINDOWED=1` | don't force fullscreen |
| `STREMIO_TV_UI=/path/index.html` | load a different UI build |
| `STREMIO_TV_TEST=1` | enable the screenshot hook used by tests |
| `STREMIO_TV_MPV_LOG=v` | more mpv logging (`v`, `debug`, `trace`); default `warn` |
| `STREMIO_TV_MPV_OPTIONS="hwdec=no"` | extra mpv options, comma-separated, applied after the defaults |
| `QTWEBENGINE_REMOTE_DEBUGGING=127.0.0.1:9222` | inspect the UI from Chrome's `chrome://inspect` |
