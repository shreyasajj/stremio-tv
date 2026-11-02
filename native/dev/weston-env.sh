#!/bin/sh
# Source inside the dev container: starts a headless Weston (real Wayland
# compositor, software GL) and points Qt at it.
export XDG_RUNTIME_DIR=/tmp/xdg-runtime
mkdir -p "$XDG_RUNTIME_DIR" && chmod 700 "$XDG_RUNTIME_DIR"
weston --backend=headless --renderer="${WESTON_RENDERER:-gl}" --socket=wayland-test \
  --width=1920 --height=1080 --idle-time=0 >/tmp/weston.log 2>&1 &
for i in $(seq 50); do [ -S "$XDG_RUNTIME_DIR/wayland-test" ] && break; sleep 0.1; done
export WAYLAND_DISPLAY=wayland-test QT_QPA_PLATFORM=wayland
# Containers have no user namespaces for Chromium's sandbox.
export QTWEBENGINE_DISABLE_SANDBOX=1
