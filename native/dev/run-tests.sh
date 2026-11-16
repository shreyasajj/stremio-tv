#!/bin/sh
# Build the native shell and run its end-to-end test on a headless Wayland
# compositor inside the dev container. From the repo root:
#   docker build -t stremio-tv-native-dev native/dev
#   docker run --rm -v "$PWD":/src -w /src -e SHOTS=1 stremio-tv-native-dev sh native/dev/run-tests.sh
set -e
# The application owns a session-bus name before creating a window. CI runners
# need their own bus, independent of any host desktop session.
if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ]; then
    exec dbus-run-session -- sh "$0" "$@"
fi
BUILD=/tmp/stremio-tv-build
cmake -S native -B "$BUILD" -G Ninja -DCMAKE_BUILD_TYPE=RelWithDebInfo >/dev/null
cmake --build "$BUILD"
. "$(dirname "$0")/weston-env.sh"
export LANG=C.UTF-8
NATIVE_BIN="$BUILD/stremio-tv-native" node test/native-test.js
