#!/bin/sh
# Fast user-only development build against an installed 0.8.1 Stremio Flatpak.
# The full production dependency build remains the adjacent YAML manifest.
set -eu
app_id=io.github.shreyasajj.StremioTV
source_root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
# script is native/packaging/, so the parent of native is the repository root.
flatpak info --user "$app_id" >/dev/null
flatpak install --user -y --noninteractive flathub org.kde.Sdk//6.10 io.qt.qtwebengine.BaseApp//6.10
stage_root=$(mktemp -d "$HOME/.cache/stremio-bridge-XXXXXX")
app_root="$stage_root/app"
headers_root="$stage_root/headers"
flatpak info --show-commit "$app_id" > "$stage_root/base-commit"
flatpak build-init --base="$app_id" --base-version=master "$app_root" "$app_id" org.kde.Sdk org.kde.Platform 6.10
base_root=$(flatpak info --show-location io.qt.qtwebengine.BaseApp//6.10)
for part in include lib/cmake lib/x86_64-linux-gnu/cmake lib/x86_64-linux-gnu/metatypes lib/metatypes mkspecs; do
    if [ -d "$base_root/files/$part" ]; then
        mkdir -p "$app_root/files/$part"
        cp -a "$base_root/files/$part/." "$app_root/files/$part/"
    fi
done
cp -a "$base_root/files/lib/libexec/qwebengine_convert_dict" "$app_root/files/lib/libexec/"
python3 - "$headers_root" <<'PY'
from pathlib import Path
import sys
from urllib.request import urlopen
root=Path(sys.argv[1])
(root/'include/mpv').mkdir(parents=True)
(root/'pkgconfig').mkdir()
mpv='https://raw.githubusercontent.com/mpv-player/mpv/b0841e8c4d156b8403dc1876c4cbd9011eb583f3/include/mpv/'
urls={f'include/mpv/{f}':mpv+f for f in ('client.h','render.h','render_gl.h','stream_cb.h')}
urls['include/mosquitto.h']='https://raw.githubusercontent.com/eclipse-mosquitto/mosquitto/766fa2c5a9bed6c65249cf555f430b982c417480/include/mosquitto.h'
for name,url in urls.items():
    (root/name).write_bytes(urlopen(url,timeout=30).read())
for name,version,lib in [('mpv','0.42.0','mpv'),('libmosquitto','2.0.22','mosquitto')]:
    (root/'pkgconfig'/f'{name}.pc').write_text(f'Name: {name}\nDescription: Matching installed media headers\nVersion: {version}\nLibs: -L/app/lib -l{lib}\nCflags: -I{root}/include\n')
PY
flatpak build --filesystem="$source_root" --filesystem="$stage_root" \
    --env=PKG_CONFIG_PATH="$headers_root/pkgconfig" "$app_root" sh -c '
        set -e
        cmake -S "$1/native" -B "$2/obj" -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/app -DCMAKE_PREFIX_PATH=/app
        cmake --build "$2/obj" -j4
        cmake --install "$2/obj"
    ' sh "$source_root" "$stage_root"
# Remove only development files added to this disposable staging tree.
rm -rf "$app_root/files/include" "$app_root/files/lib/cmake" "$app_root/files/lib/x86_64-linux-gnu/cmake" \
    "$app_root/files/lib/pkgconfig" "$app_root/files/lib/x86_64-linux-gnu/metatypes" \
    "$app_root/files/lib/metatypes" "$app_root/files/mkspecs"
flatpak build-finish "$app_root" --command=stremio-tv-native \
    --share=ipc --share=network --socket=wayland --socket=fallback-x11 --socket=pulseaudio \
    --filesystem=xdg-run/pipewire-0:ro --device=all --talk-name=org.freedesktop.ScreenSaver \
    --own-name=io.github.shreyasajj.StremioTV.Control \
    --env=QTWEBENGINEPROCESS_PATH=/app/bin/QtWebEngineProcess \
    --env=QTWEBENGINE_DICTIONARIES_PATH=/app/qtwebengine_dictionaries
flatpak build-export "$stage_root/repo" "$app_root"
flatpak build-bundle "$stage_root/repo" "$stage_root/StremioTV-bridge.flatpak" "$app_id" master
printf '%s\n' "Built: $stage_root/StremioTV-bridge.flatpak" "Rollback commit recorded in: $stage_root/base-commit"
if [ "${1:-}" = --install ]; then
    flatpak install --user --reinstall -y --noninteractive "$stage_root/StremioTV-bridge.flatpak"
fi
