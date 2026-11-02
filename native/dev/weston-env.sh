#!/bin/sh
# Source inside the dev container: starts a headless Weston (real Wayland
# compositor, software GL) and points Qt at it.
export XDG_RUNTIME_DIR=/tmp/xdg-runtime
mkdir -p "$XDG_RUNTIME_DIR" && chmod 700 "$XDG_RUNTIME_DIR"
weston --backend=headless --renderer="${WESTON_RENDERER:-gl}" --socket=wayland-test \
  --width=1920 --height=1080 --idle-time=0 >/tmp/weston.log 2>&1 &
for i in $(seq 50); do [ -S "$XDG_RUNTIME_DIR/wayland-test" ] && break; sleep 0.1; done
export WAYLAND_DISPLAY=wayland-test QT_QPA_PLATFORM=wayland
# Audio: a null sink stands in for the speakers; the test records its monitor.
if command -v pulseaudio >/dev/null; then
  pulseaudio -D --exit-idle-time=-1 --log-target=file:/tmp/pulse.log \
    --load="module-null-sink sink_name=test_out" 2>/dev/null || true
  for i in $(seq 50); do pactl info >/dev/null 2>&1 && break; sleep 0.1; done
  pactl set-default-sink test_out 2>/dev/null && export STREMIO_TV_AUDIO_SINK=test_out
fi
# Containers have no user namespaces for Chromium's sandbox.
export QTWEBENGINE_DISABLE_SANDBOX=1
# Mesa's software GL corrupts mpv's float textures at random (scaler and
# dither lookup tables, float FBOs): green, striped or black video, plain
# `mpv --vo=gpu` included. Stick to mpv's simple render path here.
export STREMIO_TV_MPV_OPTIONS="${STREMIO_TV_MPV_OPTIONS:-fbo-format=rgba8,dither-depth=no,scale=bilinear,cscale=bilinear,dscale=bilinear}"
